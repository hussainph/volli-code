/**
 * Visual proof for the one tab strip (`ui/tab-strip.tsx`).
 *
 * Drives the BUILT app to each of the two surfaces that draw a strip and
 * shoots the strip band alone, cropped, plus the whole window for context:
 *
 *   - **ticket** — the ticket detail, the folder variant, with a Doc tab (not
 *     closable) beside a live terminal Session tab (leading status dot,
 *     closable, renamable).
 *   - **home** — Home, the folder variant again: its permanent Board tab (not
 *     closable), a terminal Session tab, and Main-checkout File tabs beside
 *     them — two pinned tabs sharing a basename (so the parent-directory
 *     hints render), one italic preview tab, and one dirty tab wearing the
 *     unsaved dot in place of its ×. VC-122 folded the old standalone Project
 *     Files strip into this one, so what used to be a third surface ("files")
 *     is now this same strip carrying more kinds of tab at once.
 *
 * Each surface is shot twice: at rest, and with a tab hovered so the
 * hover-revealed close is visible. No assertions beyond "it rendered" — a human
 * judges the shots. Run it once on each side of a change and diff the pairs.
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 *
 *   Run:
 *     pnpm run build
 *     VOLLI_SKIP_CLOSE_CONFIRM=1 node apps/desktop/e2e/tab-strip-shots.mjs <out-dir>
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  assertProfileIsolated,
  cardById,
  launch,
  makeGitRepo,
  makeScratch,
  seedProjects,
  sleep,
  startTerminalSession,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const execFileAsync = promisify(execFile);

const OUT_DIR = process.argv[2] ?? join(process.cwd(), "shots", "tab-strip");
await fs.mkdir(OUT_DIR, { recursive: true });

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-tab-strip-shots-");

const PROJECT_SEED_ID = "tab-strip-project";
const PROJECT_NAME = "Voltaic";
const TICKET_PREFIX = "VLT";
const TICKET_TITLE = "Agent runtime backend";
const DISPLAY_ID = `${TICKET_PREFIX}-1`;

/** The nav item in the EXPANDED sidebar layer (the collapsed rail duplicates every label). */
function navButton(page, label) {
  return page
    .locator('[data-sidebar-presentation="expanded"]')
    .getByRole("button", { name: label, exact: true });
}

/** One row in the Home Files navigator's current folder — `relPath` is always
 * the full project-relative path (`ticket-files-panel.tsx`'s `FileRow`). */
function fileRow(page, relPath) {
  return page
    .getByTestId("home-files-panel")
    .locator(`[data-testid="ticket-files-row"][data-path="${relPath}"]`);
}

/** The whole strip band that holds one named tablist — actions cluster included. */
function stripBand(page, name) {
  return page
    .locator('[data-slot="tab-strip"]')
    .filter({ has: page.getByRole("tablist", { name, exact: true }) });
}

/**
 * Shoot one strip: the band cropped to its own bounds, and the window it sits
 * in. `hoverIndex` names the tab to point at for the second pair, because the
 * close × is hover-revealed and a resting shot cannot show it.
 */
async function shootStrip(page, name, stripLocator, { hoverIndex = 1 } = {}) {
  await sleep(400);
  await stripLocator.screenshot({ path: join(OUT_DIR, `${name}-strip.png`) });
  await page.screenshot({ path: join(OUT_DIR, `${name}-window.png`) });

  const tabs = stripLocator.getByRole("tab");
  const count = await tabs.count();
  if (count > hoverIndex) {
    await tabs.nth(hoverIndex).hover();
    await sleep(300);
    await stripLocator.screenshot({ path: join(OUT_DIR, `${name}-strip-hover.png`) });
    // Park the pointer somewhere inert so the next surface starts at rest.
    await page.mouse.move(4, 400);
  }
  console.log(`shot ${name} (${count} tabs)`);
}

const projectDir = await makeGitRepo(scratch, "voltaic-");
await fs.mkdir(join(projectDir, "src"), { recursive: true });
await fs.mkdir(join(projectDir, "lib"), { recursive: true });
await fs.writeFile(join(projectDir, "src/app.ts"), 'export const app = "src app";\n', "utf8");
await fs.writeFile(join(projectDir, "src/util.ts"), 'export const util = "src util";\n', "utf8");
await fs.writeFile(join(projectDir, "lib/app.ts"), 'export const app = "lib app";\n', "utf8");
await execFileAsync("git", ["add", "-A"], { cwd: projectDir });
await execFileAsync("git", ["commit", "-q", "-m", "seed"], { cwd: projectDir });

const app = await launch({ dbPath, userDataDir });

try {
  await assertProfileIsolated(app, userDataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await sleep(1000);
  await page.setViewportSize({ width: 1440, height: 900 });

  await seedProjects(page, [
    { id: PROJECT_SEED_ID, name: PROJECT_NAME, path: projectDir, prefix: TICKET_PREFIX },
  ]);

  // ---- ticket ------------------------------------------------------------
  const seeded = await page.evaluate(async (title) => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) throw new Error(boot.error);
    const project = boot.data.projects[0];
    const created = await window.api.tickets.create({
      projectId: project.id,
      status: "todo",
      title,
      priority: "medium",
    });
    if (!created.ok) throw new Error(created.error);
    return created.ticket.id;
  }, TICKET_TITLE);
  console.log(`seeded ticket ${seeded}`);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await sleep(1500);
  await navButton(page, "Board").click();
  await waitUntil("board card", async () => (await cardById(page, DISPLAY_ID).count()) === 1, {
    timeout: 15000,
  });
  await cardById(page, DISPLAY_ID).dblclick();
  const ticketStrip = page.getByRole("tablist", { name: "Ticket tabs", exact: true });
  await waitUntil("ticket strip", async () => (await ticketStrip.count()) === 1, {
    timeout: 15000,
  });
  // A live terminal Session beside the Doc tab: the leading status dot, the
  // closable/renamable half of the strip.
  await startTerminalSession(page);
  await waitUntil(
    "a second ticket tab",
    async () => (await ticketStrip.getByRole("tab").count()) >= 2,
    {
      timeout: 30000,
    },
  );
  await sleep(1500);
  await shootStrip(
    page,
    "ticket",
    // The band, not the tablist: the trailing action cluster lives outside the
    // tablist and is half of what this strip draws.
    stripBand(page, "Ticket tabs"),
  );

  // ---- home (Board + a terminal Session + Main-checkout File tabs) -------
  // VC-122 folded the old standalone Project Files strip into this one: File
  // tabs now sit beside Board/Session tabs in Home's own strip rather than a
  // dedicated page's.
  await page.keyboard.press("Escape");
  await sleep(600);
  await navButton(page, "Home").click();
  await sleep(1200);
  const homeStrip = stripBand(page, "Home tabs");
  await startTerminalSession(page);
  // The Board tab is always there, so a fresh terminal is the SECOND tab, and
  // the rail (with its Files page) only exists beside a Session or File tab.
  await waitUntil(
    "first session tab",
    async () => (await homeStrip.getByRole("tab").count()) >= 2,
    { timeout: 30000 },
  );
  await sleep(1200);

  await page.getByTestId("home-rail-tab-files").click();
  await waitUntil(
    "Home Files panel",
    async () => (await page.getByTestId("home-files-panel").count()) === 1,
    { timeout: 15000 },
  );
  await waitUntil("src/ row", async () => (await fileRow(page, "src").count()) === 1);
  await fileRow(page, "src").click();
  // Two pinned tabs sharing a basename (the hints), then one preview tab.
  await waitUntil("src/app.ts row", async () => (await fileRow(page, "src/app.ts").count()) === 1);
  await fileRow(page, "src/app.ts").dblclick();
  await sleep(600);
  await page.getByTestId("home-files-up").click();
  await waitUntil("lib/ row", async () => (await fileRow(page, "lib").count()) === 1);
  await fileRow(page, "lib").click();
  await waitUntil("lib/app.ts row", async () => (await fileRow(page, "lib/app.ts").count()) === 1);
  await fileRow(page, "lib/app.ts").dblclick();
  await sleep(600);
  await page.getByTestId("home-files-up").click();
  await waitUntil("src/ row again", async () => (await fileRow(page, "src").count()) === 1);
  await fileRow(page, "src").click();
  await waitUntil(
    "src/util.ts row",
    async () => (await fileRow(page, "src/util.ts").count()) === 1,
  );
  await fileRow(page, "src/util.ts").click();
  await sleep(800);
  // Dirty the first pinned tab: select it, then type into its editor.
  await page.locator('[data-testid="home-file-tab"][data-rel-path="src/app.ts"]').click();
  await waitUntil(
    "monaco ready",
    async () =>
      (await page.locator('[data-monaco-status="ready"] .monaco-editor .view-lines').count()) >= 1,
    { timeout: 30000 },
  );
  await page.locator("[data-monaco-status] .monaco-editor .view-lines").first().click();
  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.type("// draft");
  await page.keyboard.press("Enter");
  await waitUntil(
    "tab goes dirty",
    async () =>
      (await page
        .locator('[data-testid="home-file-tab"][data-rel-path="src/app.ts"][data-dirty="true"]')
        .count()) === 1,
  );
  await sleep(1000);
  await shootStrip(page, "home", homeStrip, { hoverIndex: 2 });

  console.log(`\nshots in ${OUT_DIR}`);
} finally {
  await app.close().catch(() => {});
  await cleanup();
}
