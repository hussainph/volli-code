/**
 * Visual proof for the one tab strip (`ui/tab-strip.tsx`).
 *
 * Drives the BUILT app to each of the three surfaces that draw a strip and
 * shoots the strip band alone, cropped, plus the whole window for context:
 *
 *   - **files** — Project Files, the folder variant: two pinned tabs sharing a
 *     basename (so the parent-directory hints render), one italic preview tab,
 *     and one dirty tab wearing the unsaved dot in place of its ×.
 *   - **ticket** — the ticket detail, the folder variant again, with a Doc tab
 *     (not closable) beside a live terminal Session tab (leading status dot,
 *     closable, renamable).
 *   - **home** — Home, the folder variant again, with its permanent Board tab
 *     (not closable) leading two terminal Session tabs.
 *
 * Each surface is shot twice: at rest, and with the second tab hovered so the
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

function treeFile(page, relPath) {
  return page.locator(`[data-testid="file-tree-file"][data-rel-path="${relPath}"]`);
}

function treeDir(page, relPath) {
  return page.locator(`[data-testid="file-tree-dir"][data-rel-path="${relPath}"]`);
}

async function expandDir(page, relPath, expectChild) {
  await waitUntil(`tree row ${relPath}/`, async () => (await treeDir(page, relPath).count()) === 1);
  if ((await treeFile(page, expectChild).count()) === 0) await treeDir(page, relPath).click();
  await waitUntil(
    `tree row ${expectChild}`,
    async () => (await treeFile(page, expectChild).count()) === 1,
  );
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

  // ---- files -------------------------------------------------------------
  await navButton(page, "Files").click();
  await waitUntil(
    "files workbench",
    async () => (await page.locator('[data-testid="files-workbench"]').count()) === 1,
    { timeout: 15000 },
  );
  await expandDir(page, "src", "src/app.ts");
  await expandDir(page, "lib", "lib/app.ts");
  // Two pinned tabs sharing a basename (the hints), then one preview tab.
  await treeFile(page, "src/app.ts").dblclick();
  await sleep(600);
  await treeFile(page, "lib/app.ts").dblclick();
  await sleep(600);
  await treeFile(page, "src/util.ts").click();
  await sleep(800);
  // Dirty the first tab: select it, then type into its editor.
  await page.locator('[data-testid="file-tab"][data-rel-path="src/app.ts"]').click();
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
        .locator('[data-testid="file-tab"][data-rel-path="src/app.ts"][data-dirty="true"]')
        .count()) === 1,
  );
  await shootStrip(page, "files", page.locator('[data-testid="file-tab-strip"]'), {
    hoverIndex: 2,
  });

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
    // tablist and is half of what this strip draws. Named through its tablist
    // because the Files workbench's strip stays mounted (hidden) behind this
    // surface, and a positional `.first()` finds that one.
    stripBand(page, "Ticket tabs"),
  );

  // ---- home --------------------------------------------------------------
  await page.keyboard.press("Escape");
  await sleep(600);
  await navButton(page, "Home").click();
  await sleep(1200);
  const homeStrip = stripBand(page, "Home tabs");
  await startTerminalSession(page);
  // The Board tab is always there, so a fresh terminal is the SECOND tab.
  await waitUntil(
    "first session tab",
    async () => (await homeStrip.getByRole("tab").count()) >= 2,
    { timeout: 30000 },
  );
  await sleep(1200);
  await startTerminalSession(page);
  await waitUntil(
    "a second session tab",
    async () => (await homeStrip.getByRole("tab").count()) >= 3,
    { timeout: 30000 },
  );
  await sleep(1500);
  await shootStrip(page, "home", homeStrip);

  console.log(`\nshots in ${OUT_DIR}`);
} finally {
  await app.close().catch(() => {});
  await cleanup();
}
