/**
 * Documentation screenshots for the Volli docs site (apps/docs).
 *
 * Boots the BUILT app against an isolated scratch profile, seeds the repo's
 * established demo project (voltaic / VLT), and captures the images the docs
 * pages and README embed:
 *
 *   board.png            — Home's permanent Board tab, with all five columns populated.
 *   ticket-workspace.png — a ticket's Body and its review rail, with Chat as the
 *                          explicit next action.
 *
 * `theme-picker.png` used to be the third. Its surface — Settings → Appearance's
 * app-theme picker — went with the seed-based theming system, and the file is
 * deleted.
 *
 * TODO: re-add the step as `canvas-editor.png`, shooting Settings → Appearance
 * with the canvas editor open — the pad and its orbs, the stop chips, the swatch
 * row, the vibrancy and grain sliders, and the contrast readout. The Theming
 * guide carries a matching TODO and embeds no image until that shot exists.
 *
 * Capture goes through `webContents.capturePage()`, not Playwright's
 * `page.screenshot()`. It records the built app window at the display's device
 * scale factor, so a Retina run writes 2x PNGs without exposing the person's
 * own projects, chats, or desktop. The fixture runs in an isolated profile and
 * must prove its project is ready before it writes either image; a setup warning
 * is evidence of a broken shot, not documentation.
 *
 * Like every other probe in this directory this is MANUALLY RUN (needs a
 * display + the built app) and is NOT wired into `vp test`:
 *
 *   pnpm run build
 *   env -u ELECTRON_RUN_AS_NODE node apps/desktop/e2e/docs-shots.mjs
 *
 * Optional first argument overrides the output directory.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  assertProfileIsolated,
  cardById,
  createRunner,
  goToBoard,
  launch,
  makeGitRepo,
  makeScratch,
  REPO,
  seedProjects,
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const execFileAsync = promisify(execFile);

const OUT_DIR = process.argv[2] ?? join(REPO, "apps", "docs", "src", "assets", "screenshots");

/** Linear-ish window the docs images are composed for. */
const WINDOW = { width: 1440, height: 900 };

/** The repo's established demo project (docs/DESIGN.md). */
const PROJECT = { id: "docs-shots-voltaic", name: "voltaic", prefix: "VLT", colorIndex: 2 };

/**
 * The seeded board, in creation order — so the hero lands on VLT-14, the demo
 * ticket id the rest of the docs use. Nothing here is a placeholder: every row
 * is a plausible ticket for a terminal-agent planner.
 */
const TICKETS = [
  ["done", "Bundle the volli CLI with the app", "medium"],
  ["done", "Kanban board scaffold", "low"],
  ["done", "Ghostty config adapter for the terminal", "medium"],
  ["done", "One git worktree per ticket, branched on kickoff", "high"],
  ["backlog", "Stream PTY output through a shared ring buffer", "medium"],
  ["backlog", "Per-project setup command before the agent boots", "low"],
  ["backlog", "Remember board zoom level per project", "low"],
  ["todo", "Native notification when an agent stops", "high"],
  ["todo", "Full-text search over session transcripts", "medium"],
  ["todo", "Show worktree disk usage in the ticket rail", "low"],
  ["needs_review", "Warn before closing a session with a running process", "high"],
  ["needs_review", "Resume a parked session from the sidebar", "medium"],
  ["doing", "Rebuild the diff viewer on the changeset store", "high"],
  // 14th → VLT-14, the hero.
  ["doing", "Cache composer drafts per project", "high"],
  ["backlog", "Import an existing repo without a first commit", "medium"],
  ["todo", "Collapse empty board columns into the rail", "low"],
  ["backlog", "Archive tickets whose worktree is older than 30 days", "low"],
  ["done", "Restore open tabs after a relaunch", "medium"],
  ["backlog", "Refuse to archive a ticket with a dirty worktree", "high"],
  ["todo", "Keyboard-only triage in the list view", "medium"],
  ["needs_review", "Retry worktree creation on a stale base", "medium"],
  ["backlog", "Group sessions by harness in the sidebar", "low"],
  ["todo", "Inline diff decorations in the file editor", "medium"],
  ["done", "Persist the ticket rail width", "low"],
];

/** Which of the above is the hero (0-based) — must be the 14th created ticket. */
const HERO_INDEX = 13;

const HERO_BODY = [
  "The composer keeps one draft at a time, so switching projects mid-compose",
  "throws away whatever was half-written in the other one.",
  "",
  "- Key the draft cache on `{projectId, ticketId}` instead of a module slot",
  "- Restore the draft when the composer re-opens on the same project",
  "- Drop a draft once its ticket is actually created",
];

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-docs-shots-");
const { attempt, check, summarize } = createRunner();

await fs.mkdir(OUT_DIR, { recursive: true });
const projectDir = await makeGitRepo(scratch, "voltaic-");
await seedRepoTree(projectDir);
await installFixtureDependencies(projectDir);

const app = await launch({ dbPath, userDataDir });

try {
  await assertProfileIsolated(app, userDataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await waitUntil("app surface", () =>
    page.evaluate(() => document.querySelector("[data-volli-surface]") !== null),
  );

  const size = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    // `setContentSize(1440, 900)` is clamped to the screen's WORK AREA, which on
    // a 1440x900 retina Mac is 1440x810 once the menu bar and Dock are taken
    // out. Simple fullscreen covers both, so the content box is exactly the
    // display — 1440x900 at scaleFactor 2 — which is the geometry the docs
    // images are specified in. Nothing else about the window changes: the
    // renderer paints its own chrome band, and capturePage only ever reads the
    // web contents, so the shot is the app window and nothing around it.
    win.setSimpleFullScreen(true);
    win.focus();
    const [width, height] = win.getContentSize();
    return { width, height };
  });
  check(
    0,
    `window sized to ${WINDOW.width}x${WINDOW.height}`,
    size.width === WINDOW.width && size.height === WINDOW.height,
    `content size ${size.width}x${size.height}`,
  );

  await seedProjects(page, [{ ...PROJECT, path: projectDir }]);

  const seeded = await page.evaluate(
    async ({ tickets, heroIndex, body }) => {
      const boot = await window.api.data.bootstrap();
      if (!boot.ok) throw new Error(boot.error);
      const project = boot.data.projects[0];
      if (!project) throw new Error("no project imported");
      const created = [];
      for (const [status, title, priority] of tickets) {
        const result = await window.api.tickets.create({
          projectId: project.id,
          status,
          title,
          priority,
        });
        if (!result.ok) throw new Error(result.error);
        created.push({ id: result.ticket.id, number: result.ticket.ticketNumber });
      }
      const hero = created[heroIndex];
      await window.api.tickets.update({ ticketId: hero.id, body: body.join("\n") });
      await window.api.tickets.setLabels({
        ticketId: hero.id,
        labels: ["composer", "renderer"],
      });
      return { prefix: project.ticketPrefix, heroNumber: hero.number };
    },
    { tickets: TICKETS, heroIndex: HERO_INDEX, body: HERO_BODY },
  );
  const heroId = `${seeded.prefix}-${seeded.heroNumber}`;
  check(1, "hero ticket is VLT-14", heroId === "VLT-14", `hero is ${heroId}`);

  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await waitUntil("board", async () => (await cardById(page, heroId).count()) === 1);

  const readiness = await fixtureReadiness(page, projectDir);
  const fixtureReady = readiness.dependencies === "installed" && !readiness.alertVisible;
  check(
    2,
    "fixture project is ready for Sessions",
    fixtureReady,
    `dependencies=${readiness.dependencies ?? "none"} alert=${readiness.alertVisible}`,
  );
  if (!fixtureReady) throw new Error(`fixture is not capture-ready: ${JSON.stringify(readiness)}`);

  // ---- 1. the board -------------------------------------------------------
  await attempt(3, "board.png", async () => {
    await goToBoard(page);
    const fit = await fitBoardColumns(page);
    await parkPointer(page);
    await sleep(800);
    const shot = await capture("board.png");
    return { ok: shot.ok && fit.overflow === 0, detail: `${shot.detail} · ${fit.trace}` };
  });

  // ---- 2. the ticket workspace -------------------------------------------
  await attempt(4, "ticket-workspace.png", async () => {
    // The board shot may have zoomed out / hidden the sidebar to fit five
    // columns; the workspace shot wants the released, chat-first default back
    // at native scale. Do not open a terminal to make a screenshot: it is an
    // optional companion, not the primary product story.
    await restoreChrome(page);
    await cardById(page, heroId).dblclick();
    await waitUntil(
      "ticket workspace",
      async () =>
        (await page.getByRole("tablist", { name: "Ticket tabs", exact: true }).count()) === 1,
    );
    await waitUntil("ticket body", () =>
      page.getByText(HERO_BODY[0], { exact: false }).isVisible(),
    );
    await parkPointer(page);
    await sleep(600);
    return capture("ticket-workspace.png");
  });
} catch (error) {
  check("!", "docs shots crashed", false, String(error?.stack ?? error));
} finally {
  await app.close().catch(() => {});
  await cleanup();
}

console.log(`\nshots written to ${OUT_DIR}`);
process.exit(summarize());

// ---- helpers ---------------------------------------------------------------

/**
 * Capture the COMPOSITED window (see the module header for why this is not
 * `page.screenshot`) and write it to the output dir. Returns the runner's
 * `{ok, detail}` shape with the PNG's real pixel dimensions, read back out of
 * the file's IHDR so the check reports what actually landed on disk.
 */
async function capture(name) {
  const base64 = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const image = await win.webContents.capturePage();
    return image.toPNG().toString("base64");
  });
  const bytes = Buffer.from(base64, "base64");
  const path = join(OUT_DIR, name);
  await fs.writeFile(path, bytes);
  const { width, height } = pngSize(bytes);
  return {
    ok: bytes.length > 20_000 && width >= WINDOW.width,
    detail: `${width}x${height}, ${(bytes.length / 1024).toFixed(0)} KB → ${path}`,
  };
}

/** PNG dimensions straight from the IHDR chunk. */
function pngSize(bytes) {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * How far the board's column strip overflows its scroller, in CSS px. 0 means
 * every column — including Done, the last one — is on screen.
 */
function boardOverflow(page) {
  return page.evaluate(() => {
    const scroller = Array.from(document.querySelectorAll("div.overflow-x-auto")).find(
      (el) => el.querySelector("article") !== null,
    );
    return scroller === undefined ? -1 : scroller.scrollWidth - scroller.clientWidth;
  });
}

/**
 * Make all five columns fit the 1440px window.
 *
 * Five 300px columns do not fit beside the navigation sidebar at native scale,
 * and the docs shot is about the column STRUCTURE, so this walks the app's own
 * zoom ladder (0.9, then 0.8 — `UI_SCALE_STEPS` in stores/ui.ts) and, only if
 * that is still not enough, hides the sidebar. The zoom command is sent as the
 * IPC the View menu sends rather than by clicking the menu item: `sendZoom`
 * targets `getFocusedWindow()`, and window focus under an automated run is not
 * something a screenshot script should have to depend on.
 */
async function fitBoardColumns(page) {
  const trace = [];
  const zoom = async (command) => {
    await app.evaluate(({ BrowserWindow }, cmd) => {
      BrowserWindow.getAllWindows()[0].webContents.send("volli:ui-zoom-command", cmd);
    }, command);
    await sleep(500);
  };

  let overflow = await boardOverflow(page);
  trace.push(`sidebar@1.0:${overflow}`);
  for (const rung of ["0.9", "0.8"]) {
    if (overflow <= 0) break;
    await zoom("out");
    overflow = await boardOverflow(page);
    trace.push(`sidebar@${rung}:${overflow}`);
  }
  if (overflow > 0) {
    await page.getByRole("button", { name: "Toggle navigation sidebar" }).click();
    await sleep(600);
    overflow = await boardOverflow(page);
    trace.push(`no-sidebar:${overflow}`);
  }
  return { overflow: Math.max(0, overflow), trace: trace.join(" ") };
}

/** Undo whatever {@link fitBoardColumns} did: native scale, sidebar showing. */
async function restoreChrome(page) {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("volli:ui-zoom-command", "reset");
  });
  // `data-state` on the sidebar root is the only honest signal: the toggle
  // button's label never changes with its state, the collapsed icon rail still
  // carries a "Board" button by accessible name, and an offcanvas sidebar is
  // moved out of view rather than removed — so it still reports as "visible".
  const sidebarState = () =>
    page.evaluate(
      () =>
        document.querySelector('[data-slot="sidebar"][data-side="left"]')?.dataset.state ?? null,
    );
  if ((await sidebarState()) === "collapsed") {
    await page.getByRole("button", { name: "Toggle navigation sidebar" }).click();
    await waitUntil("sidebar expanded", async () => (await sidebarState()) === "expanded");
  }
  await sleep(600);
}

/**
 * Move the pointer somewhere inert. Hover states (card hover, theme-row preview,
 * button highlight) are real UI but they make a screenshot look mid-interaction.
 */
async function parkPointer(page) {
  await page.mouse.move(WINDOW.width - 4, WINDOW.height - 4);
}

/**
 * Give the fixture repo a plausible source tree, so the board and ticket body
 * read like a real project rather than a lone README.
 */
async function seedRepoTree(dir) {
  const files = {
    "package.json": '{\n  "name": "voltaic",\n  "private": true\n}\n',
    "README.md": "# voltaic\n\nDemo project for the Volli documentation screenshots.\n",
    "src/renderer/src/stores/drafts.ts": "export const drafts = new Map<string, string>();\n",
    "src/renderer/src/components/board/new-ticket/composer.tsx":
      "export function Composer() {\n  return null;\n}\n",
    "src/main/pty.ts": "export function spawnPty(): void {}\n",
  };
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name);
    await fs.mkdir(join(path, ".."), { recursive: true });
    await fs.writeFile(path, contents);
  }
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "scaffold the renderer stores"], { cwd: dir });
}

/**
 * This fixture is a JavaScript workspace with no packages to install. The
 * product correctly regards its dependencies as ready only when `node_modules`
 * exists, so create a harmless marker after committing the demo source. It is
 * deliberately untracked: no documentation screenshot should imply that
 * dependency folders belong in source control.
 */
async function installFixtureDependencies(dir) {
  const nodeModules = join(dir, "node_modules");
  await fs.mkdir(nodeModules, { recursive: true });
  await fs.writeFile(join(nodeModules, ".volli-docs-fixture"), "ready\n", "utf8");
}

/**
 * Capture is allowed only from a project that would not display a setup
 * warning. Query the same CLI-status seam the UI uses, then confirm its notice
 * has settled out of the rendered window.
 */
async function fixtureReadiness(page, cwd) {
  const status = await page.evaluate(async (projectPath) => {
    const response = await window.api.cli.status({ cwd: projectPath });
    if (!response.ok) return { dependencies: null, statusError: String(response.error) };
    return { dependencies: response.status.environment.session.dependencies, statusError: null };
  }, cwd);
  await sleep(800);
  const alertVisible = await page
    .getByText(`Sessions aren't ready for ${PROJECT.name}`, { exact: true })
    .isVisible()
    .catch(() => false);
  return { ...status, alertVisible };
}
