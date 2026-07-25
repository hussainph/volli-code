/**
 * Visual proof for the VC-108 icon-mode ticket rail.
 *
 * Boots the BUILT app, opens a ticket with a live session, screenshots each
 * of the four rail modes, then exits. Not a pass/fail contract suite — that
 * lives in ticket-detail-smoke.mjs checks 8 / 8b / 8c.
 *
 *   pnpm run build
 *   node apps/desktop/e2e/ticket-rail-shots.mjs
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
    {
      id: "rail-proj",
      name: "Rail Shots",
      path: projectDir,
      prefix: "RS",
    },
  ]);

  // Create a ticket via the New-ticket composer so we land in a real detail.
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  const title = page.getByRole("textbox", { name: /title/i }).or(page.locator("input").first());
  await waitUntil("composer open", async () => (await title.count()) >= 1);
  // Prefer accessible name; fall back to the first visible input in the dialog.
  const titleField =
    (await page.getByPlaceholder(/title|Ticket/i).count()) >= 1
      ? page.getByPlaceholder(/title|Ticket/i).first()
      : page.locator('[role="dialog"] input').first();
  await titleField.fill("Icon-mode rail visual proof");
  // Create (not Create & start) — we boot a shell ourselves for the live shot.
  const createBtn = page.getByRole("button", { name: /^Create$/i });
  if ((await createBtn.count()) >= 1) await createBtn.click();
  else
    await page
      .getByRole("button", { name: /Create/i })
      .first()
      .click();

  await waitUntil("ticket detail open", async () => {
    return (await page.getByRole("tablist").count()) >= 1;
  });

  const aside = page.locator("aside");
  await waitUntil("rail visible", async () => (await aside.count()) === 1);

  // Boot a live session so the Sessions mode shot isn't an empty list.
  await aside.getByRole("button", { name: "New session" }).click();
  await waitUntil("session tab", async () => {
    return (await page.getByRole("tab", { name: "Session 1", exact: true }).count()) === 1;
  }).catch(() => null);

  for (const mode of MODES) {
    await attempt(mode, `screenshot rail-${mode}.png`, async () => {
      await aside.getByTestId(`ticket-rail-mode-${mode}`).click();
      await waitUntil(`${mode} pressed`, async () => {
        return (
          (await aside.getByTestId(`ticket-rail-mode-${mode}`).getAttribute("aria-pressed")) ===
          "true"
        );
      });
      // Settle layout before capture.
      await page.waitForTimeout(250);
      const path = join(SHOT_DIR, `rail-${mode}.png`);
      await page.screenshot({ path, fullPage: false });
      const stat = await fs.stat(path);
      return { ok: stat.size > 1000, detail: path };
    });
  }

  // One wider shot with the live session tab selected.
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
