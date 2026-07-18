/**
 * Visual probe for the button-shape decision (rounded-md vs capsule/pill):
 * launches the built app against a scratch DB, seeds a realistic board, and
 * captures each key surface TWICE — as built, then with a runtime CSS override
 * that forces every `[data-slot=button]` to border-radius 9999px. No rebuild
 * needed; a human judges the pairs. Surfaces: board (toolbar), the new-ticket
 * composer (dialog closeup), and ticket detail.
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 *
 *   Run:
 *     pnpm run build
 *     node apps/desktop/e2e/button-shape-shots.mjs [out-dir]
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron } from "playwright-core";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APP_DIR = join(REPO, "apps", "desktop");
const ELECTRON = join(
  APP_DIR,
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
  "Contents",
  "MacOS",
  "Electron",
);

const OUT_DIR = process.argv[2] ?? join(APP_DIR, "e2e", "shots-button-shape");
const SCRATCH = await fs.mkdtemp(join(os.tmpdir(), "volli-button-shape-"));
const USER_DATA_DIR = join(SCRATCH, "user-data");
const DB_PATH = join(SCRATCH, "volli.db");
await fs.mkdir(USER_DATA_DIR, { recursive: true });
await fs.mkdir(OUT_DIR, { recursive: true });
const PROJECT_DIR = await fs.realpath(await fs.mkdtemp(join(SCRATCH, "project-")));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PILL_CSS = "[data-slot=button] { border-radius: 9999px !important; }";

async function injectPill(page) {
  await page.evaluate((css) => {
    const el = document.createElement("style");
    el.id = "pill-probe";
    el.textContent = css;
    document.head.append(el);
  }, PILL_CSS);
}

async function removePill(page) {
  await page.evaluate(() => document.getElementById("pill-probe")?.remove());
}

/** Screenshot `target` as `<name>-a-current.png` / `<name>-b-pill.png`. */
async function shootPair(page, target, name) {
  await removePill(page);
  await sleep(150);
  await target.screenshot({ path: join(OUT_DIR, `${name}-a-current.png`) });
  await injectPill(page);
  await sleep(150);
  await target.screenshot({ path: join(OUT_DIR, `${name}-b-pill.png`) });
  await removePill(page);
}

const app = await _electron.launch({
  executablePath: ELECTRON,
  args: [APP_DIR, `--user-data-dir=${USER_DATA_DIR}`],
  env: {
    ...process.env,
    VOLLI_DB_PATH: DB_PATH,
    VOLLI_SKIP_CLOSE_CONFIRM: "1",
  },
});

try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await sleep(1000);
  await page.setViewportSize({ width: 1680, height: 1000 });

  // Seed the project via the same localStorage-import path the other smokes use.
  await page.evaluate(
    ({ path }) => {
      localStorage.setItem(
        "volli:projects",
        JSON.stringify({
          state: {
            projects: [
              {
                id: "button-shape-project",
                name: "Volli",
                path,
                ticketPrefix: "VC",
                colorIndex: 2,
                createdAt: Date.now(),
              },
            ],
            selectedProjectId: "button-shape-project",
          },
          version: 1,
        }),
      );
    },
    { path: PROJECT_DIR },
  );
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await sleep(1200);

  const seed = await page.evaluate(async () => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) return { ok: false, error: boot.error };
    const project = boot.data.projects[0];
    if (!project) return { ok: false, error: "no project" };
    const mk = (status, title, priority) =>
      window.api.tickets.create({ projectId: project.id, status, title, priority });
    const hero = await mk("doing", "Set up agent database for agent infrastructure", "high");
    if (!hero.ok) return { ok: false, error: hero.error };
    await window.api.tickets.setLabels({
      ticketId: hero.ticket.id,
      labels: ["AI", "Back-end"],
    });
    await mk("backlog", "Bundle the volli CLI with the app", "medium");
    await mk("todo", "Native notifications on agent stop", "high");
    await mk("needs_review", "Ghostty config adapter", "medium");
    await mk("done", "Kanban board scaffold", "low");
    return { ok: true };
  });
  if (!seed.ok) throw new Error(`seed failed: ${seed.error}`);

  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await sleep(1500);

  // 1. Board — toolbar + header buttons.
  await shootPair(page, page, "1-board");

  // 2. Composer — closeup of the dialog, with a title typed so the primary
  //    kickoff action renders enabled.
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  await sleep(500);
  await page.getByPlaceholder("Ticket title").fill("Session transcript indexing");
  await sleep(200);
  const composer = page.locator('[data-testid="new-ticket-composer"]');
  if ((await composer.count()) === 1) {
    await shootPair(page, composer, "2-composer");
  } else {
    console.log("composer dialog not found — skipping composer pair");
  }
  await page.keyboard.press("Escape");
  await sleep(200);
  await page.keyboard.press("Escape");
  await sleep(400);

  // 3. Ticket detail — tabs, properties, activity buttons.
  await page.locator("article", { hasText: "Set up agent database" }).first().dblclick();
  await sleep(1200);
  await shootPair(page, page, "3-ticket-detail");

  console.log(`shots written to ${OUT_DIR}`);
} finally {
  await app.close().catch(() => {});
  await fs.rm(SCRATCH, { recursive: true, force: true }).catch(() => {});
}
