/**
 * Documentation screenshots for the Volli docs site (apps/docs).
 *
 * Boots the BUILT app against an isolated scratch profile, seeds the repo's
 * established demo project (voltaic / VLT), and captures the images the docs
 * pages embed:
 *
 *   board.png            — the kanban board, all five columns populated.
 *   ticket-workspace.png — a ticket open in its workspace with a live terminal
 *                          session and real output in it.
 *
 * `theme-picker.png` used to be the third. Its surface — Settings → Appearance's
 * app-theme picker — went with the seed-based theming system, and the canvas
 * editor that replaces it has not landed yet. The step comes back with that
 * editor rather than shooting the interim placeholder.
 *
 * Two things are deliberate here and worth keeping:
 *
 *   • Capture goes through `webContents.capturePage()`, not Playwright's
 *     `page.screenshot()`. The terminal is a WebGPU canvas whose pixels never
 *     reach the DOM; CDP's screenshot path can hand back an empty canvas for it,
 *     while capturePage reads the COMPOSITED window — the same pixels a person
 *     sees — and it comes back at the display's device scale factor, so the PNGs
 *     are 2x on a retina Mac with no extra plumbing.
 *
 *   • The terminal transcript comes from a fake harness binary (the
 *     lib/fake-harness.mjs shadowing trick: scratch bin dir prepended to PATH,
 *     scratch ZDOTDIR so the developer's own dotfiles are never sourced). The
 *     docs must not depend on any coding agent being installed, and the shot
 *     must not advertise a particular vendor's CLI, so the fake is installed
 *     under the neutral name `agent` — Volli is harness-agnostic and this is
 *     what any command template looks like from the terminal's side.
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
import { buildFakeHarness, harnessEnv } from "./lib/fake-harness.mjs";

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

/**
 * The fake harness transcript. Deliberately vendor-neutral: Volli drives any
 * CLI harness, and a docs screenshot should not read as an endorsement of one.
 * Written as a shell script body so the ANSI colors are what the terminal
 * actually renders rather than something faked in the DOM.
 */
const AGENT_SCRIPT = String.raw`#!/bin/sh
# Fake, vendor-neutral coding-agent CLI for the docs screenshots. Prints a
# plausible transcript, then blocks so the session reads as still running.
b=$(printf '\033[1m'); d=$(printf '\033[2m'); g=$(printf '\033[32m')
o=$(printf '\033[38;5;209m'); r=$(printf '\033[0m')
printf '%s\n' ""
printf '  %sagent%s  voltaic · VLT-14  %svolli/VLT-14-composer-draft-cache%s\n' "$b" "$r" "$d" "$r"
printf '%s\n' ""
printf '  %sPlan%s\n' "$b" "$r"
printf '    1. key the draft cache on {projectId, ticketId}\n'
printf '    2. restore the draft when the composer re-opens\n'
printf '    3. drop a draft once its ticket is created\n'
printf '%s\n' ""
printf '  %s>%s read   src/renderer/src/components/board/new-ticket/composer.tsx\n' "$o" "$r"
printf '  %s>%s read   src/renderer/src/stores/drafts.ts\n' "$o" "$r"
printf '  %s>%s edit   src/renderer/src/stores/drafts.ts        %s+34 -6%s\n' "$o" "$r" "$g" "$r"
printf '  %s>%s new    src/renderer/src/stores/drafts.test.ts   %s+61%s\n' "$o" "$r" "$g" "$r"
printf '%s\n' ""
printf '  %sDrafts are keyed on {projectId, ticketId} now, so switching projects%s\n' "$d" "$r"
printf '  %smid-compose no longer clobbers the draft in the other one.%s\n' "$d" "$r"
printf '%s\n' ""
printf '  %s>%s run    pnpm -C apps/desktop test drafts\n' "$o" "$r"
printf '         %s+%s src/renderer/src/stores/drafts.test.ts  (9 tests) 112ms\n' "$g" "$r"
printf '         %s9 passed%s · 0 failed\n' "$g" "$r"
printf '%s\n' ""
printf '  %s>%s Ready for review. Anything else on this ticket?%s\n' "$o" "$r" "$r"
printf '%s\n' ""
exec cat
`;

/** A neutral zsh prompt: the default one embeds the machine's hostname. */
const PROMPT_LINE =
  "\n# docs screenshots: neutral prompt (the default one prints the hostname).\n" +
  "PROMPT='%F{245}%1~%f %F{208}>%f '\nRPROMPT=''\n";

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-docs-shots-");
const { attempt, check, summarize } = createRunner();

await fs.mkdir(OUT_DIR, { recursive: true });
const home = join(scratch, "home");
await fs.mkdir(join(home, ".config"), { recursive: true });

const projectDir = await makeGitRepo(scratch, "voltaic-");
await seedRepoTree(projectDir);

// The shadowing scaffolding (scratch bin dir + PATH-neutral ZDOTDIR); the
// `claude`/`codex`/`opencode` fakes it writes are unused here — the docs shot
// runs the neutral `agent` binary added next to them.
const harness = await buildFakeHarness(scratch);
await fs.writeFile(join(harness.binDir, "agent"), AGENT_SCRIPT, { mode: 0o755 });
await fs.chmod(join(harness.binDir, "agent"), 0o755);
await fs.appendFile(join(harness.zdotDir, ".zshrc"), PROMPT_LINE);

const app = await launch({
  dbPath,
  userDataDir,
  extraEnv: {
    ...harnessEnv(harness),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
  },
});

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
  await sleep(1200);

  // ---- 1. the board -------------------------------------------------------
  await attempt(2, "board.png", async () => {
    await goToBoard(page);
    const fit = await fitBoardColumns(page);
    await parkPointer(page);
    await sleep(800);
    const shot = await capture("board.png");
    return { ok: shot.ok && fit.overflow === 0, detail: `${shot.detail} · ${fit.trace}` };
  });

  // ---- 2. the ticket workspace -------------------------------------------
  await attempt(3, "ticket-workspace.png", async () => {
    // The board shot may have zoomed out / hidden the sidebar to fit five
    // columns; the workspace shot wants the app back at native scale.
    await restoreChrome(page);
    await cardById(page, heroId).dblclick();
    await waitUntil("detail view", async () => (await page.getByRole("tablist").count()) >= 1);

    const aside = page.locator("aside");
    await waitUntil("ticket rail", async () => (await aside.count()) === 1);
    await aside.getByRole("button", { name: "New session" }).click();
    // The session boots a worktree + PTY; the canvas is what says it is live.
    await waitUntil("terminal canvas", async () => {
      const rect = await visibleCanvas(page);
      return rect !== null && rect.width > 200;
    });
    await sleep(2500);

    const rect = await visibleCanvas(page);
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await sleep(400);
    await page.keyboard.type("clear");
    await page.keyboard.press("Enter");
    await sleep(600);
    await page.keyboard.type('agent "Cache composer drafts per project"');
    await page.keyboard.press("Enter");
    // Poll for the transcript instead of sleeping on it: the fake writes its
    // last line and then blocks on stdin, so "still running" is the steady
    // state and there is no completion event to wait for.
    await sleep(2500);
    await parkPointer(page);
    await sleep(600);
    return capture("ticket-workspace.png");
  });

  // ---- 3. the app theme surface -------------------------------------------
  // Was the seed picker; that surface is the canvas editor now and lands with
  // it. Nothing here to shoot until it does — a shot of the interim placeholder
  // would date the docs the day the editor arrives.
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

/** The visible terminal canvas's viewport rect (the active tab's), or null. */
function visibleCanvas(page) {
  return page.evaluate(() => {
    const canvas = Array.from(document.querySelectorAll("canvas")).find(
      (el) => el.offsetParent !== null && el.clientWidth > 0 && el.clientHeight > 0,
    );
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
}

/**
 * Move the pointer somewhere inert. Hover states (card hover, theme-row preview,
 * button highlight) are real UI but they make a screenshot look mid-interaction.
 */
async function parkPointer(page) {
  await page.mouse.move(WINDOW.width - 4, WINDOW.height - 4);
}

/**
 * Give the fixture repo a plausible source tree, so the worktree the session
 * opens in — and anything in the shot that lists files — reads like a real
 * project instead of a lone README.
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
