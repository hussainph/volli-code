/**
 * VC-1203: a large profile's launch, on a small one. The database check runs
 * off main, the app's own window opens on the check's page, and the app loads
 * into that same window once the host is composed.
 *
 * Run after the desktop build:
 *   node apps/desktop/e2e/database-check-window-smoke.mjs
 *
 * Every other smoke's database is far under the size that sends the check off
 * main, and a small check answers long before the window's 400 ms, so no
 * other lane takes this path. Two environment-only seams take it here
 * (`src/main/database-check-smoke.ts`): every existing file goes to the
 * worker, and the launch is held after the worker answers, until this smoke
 * releases it. Neither changes what is checked; the 400 ms timer is real.
 *
 *  1. A seed launch creates the profile, a project and one ticket.
 *  2. A routine relaunch: the first window shows the check's page; on release
 *     the SAME Electron window loads the app, and the board works in it.
 *  3. Another relaunch: the person closes the window during the check; on
 *     release the app opens a new window, and the board works in it.
 *
 * Everything lives under a fresh ignored <workspace>/.tmp/check-window-*
 * directory. Display required; never builds artifacts.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  REPO,
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  cardById,
  closeAppBounded,
  createDeadline,
  firstAppWindow,
  goToBoard,
  launch,
  makeGitRepo,
  quitEndedByApp,
  seedProjects,
  waitUntil,
  writeFakeLoginShell,
} from "./lib/smoke-kit.mjs";

const CHECKING_LABEL = "Checking your data";
const PREFIX = "CHK";
/** The two seams, as `src/main/database-check-smoke.ts` names them. */
const CHECK_SEAMS = {
  VOLLI_SMOKE_DATABASE_CHECK_OFF_MAIN_BYTES: "0",
  VOLLI_SMOKE_HOLD_DATABASE_CHECK: "1",
};
const checks = [];
const runs = new Set();
let scratch;

function bounded(label, operation, timeout = 8000) {
  return createDeadline({ label, expiresAt: Date.now() + timeout }).run(operation);
}

async function check(label, operation) {
  await operation();
  checks.push(label);
  console.log(`PASS: ${label}`);
}

function isCheckPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/updating.html" && parsed.searchParams.get("work") === "check";
  } catch {
    return false;
  }
}

async function profile() {
  const root = join(scratch, "profile");
  const userDataDir = join(root, "user-data");
  const home = join(root, "home");
  const worktrees = join(root, "worktrees");
  for (const dir of [userDataDir, home, worktrees]) await fs.mkdir(dir, { recursive: true });
  const shell = await writeFakeLoginShell(join(root, "bin"), process.env.PATH ?? "/usr/bin:/bin");
  return {
    root,
    userDataDir,
    dbPath: join(userDataDir, "volli.db"),
    extraEnv: {
      HOME: home,
      ZDOTDIR: home,
      SHELL: shell,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
      VOLLI_AGENT_HOME: home,
      VOLLI_WORKTREE_HOME_DIR: worktrees,
      VOLLI_SKIP_AGENT_TOOLS: "1",
      VOLLI_SKIP_CLOSE_CONFIRM: "1",
      VOLLI_SMOKE_BROWSER_HOST: "0",
      VOLLI_BROWSER_PROBE: "0",
    },
  };
}

async function open(config, label, extraEnv = {}) {
  const app = await launch({ ...config, extraEnv: { ...config.extraEnv, ...extraEnv } });
  const run = { app, label, stderr: "", output: "" };
  runs.add(run);
  // Main's log, both streams: the quit's exit line says how it ended.
  app.process().stdout?.on("data", (chunk) => {
    run.output = `${run.output}${chunk}`.slice(-64000);
  });
  app.process().stderr?.on("data", (chunk) => {
    run.output = `${run.output}${chunk}`.slice(-64000);
    run.stderr = `${run.stderr}${chunk}`.slice(-24000);
  });
  await bounded(`${label}: profile isolation`, () =>
    assertProfileIsolated(app, config.userDataDir),
  );
  return run;
}

/** Ended by the app: exit 0, or its exit watch's SIGKILL 5 s after the exit call (VC-652). */
async function close(run) {
  const started = Date.now();
  const exit = await closeAppBounded(run.app, { closeGraceMs: 20000 });
  console.log(`CLEANUP: ${run.label}: ${Date.now() - started} ms ${JSON.stringify(exit)}`);
  runs.delete(run);
  assert.ok(quitEndedByApp(exit, run.output), `${run.label} did not quit cleanly`);
}

/** Every Electron window main holds, with the page each shows. */
function windows(run) {
  return bounded(`${run.label}: windows`, () =>
    run.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        id: window.id,
        url: window.webContents.getURL(),
        visible: window.isVisible(),
      })),
    ),
  );
}

/** The first window, on the check's page, while the launch is held after the check. */
async function heldCheckWindow(run) {
  const page = await bounded(`${run.label}: first window`, () => run.app.firstWindow(), 30000);
  await page.waitForURL((url) => isCheckPage(url.href), { timeout: 30000 });
  await page.getByRole("status").getByText(CHECKING_LABEL, { exact: true }).waitFor();
  await waitUntil(
    `${run.label}: the launch held after the check`,
    () =>
      bounded("hold", () =>
        run.app.evaluate(() => typeof globalThis.volliSmokeReleaseDatabaseCheck === "function"),
      ),
    { timeout: 30000, interval: 100 },
  );
  const shown = await windows(run);
  assert.equal(shown.length, 1, `one window during the check: ${JSON.stringify(shown)}`);
  assert.ok(isCheckPage(shown[0].url), `the window shows the check: ${shown[0].url}`);
  return { page, windowId: shown[0].id };
}

function release(run) {
  return bounded(`${run.label}: release`, () =>
    run.app.evaluate(() => globalThis.volliSmokeReleaseDatabaseCheck()),
  );
}

/**
 * The seeded ticket on the board, then a ticket written through this window's
 * own bridge and read back onto its board after a reload.
 */
async function assertBoardWorks(run, page, { number, title }) {
  await goToBoard(page);
  await cardById(page, `${PREFIX}-1`).waitFor({ timeout: 15000 });
  const created = await bounded(`${run.label}: create a ticket`, () =>
    page.evaluate(async (ticketTitle) => {
      const boot = await window.api.data.bootstrap();
      if (!boot.ok) return { ok: false, error: boot.error };
      const project = boot.data.projects[0];
      const result = await window.api.tickets.create({
        projectId: project.id,
        status: "todo",
        title: ticketTitle,
        priority: "medium",
      });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    }, title),
  );
  assert.deepEqual(created, { ok: true });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await goToBoard(page);
  await cardById(page, `${PREFIX}-${number}`)
    .filter({ hasText: title })
    .waitFor({ timeout: 15000 });
}

async function main() {
  await fs.mkdir(join(REPO, ".tmp"), { recursive: true });
  scratch = await fs.mkdtemp(join(REPO, ".tmp", "check-window-"));
  const config = await profile();
  const repo = await makeGitRepo(scratch);

  const seed = await open(config, "seed launch");
  await check("a fresh profile boots with a project and one ticket", async () => {
    const page = await firstAppWindow(seed.app, { timeout: 30000 });
    await page.waitForLoadState("domcontentloaded");
    assertBuiltRendererLoaded(page);
    await seedProjects(page, [
      { id: "check-window-project", name: "Check Window", path: repo, prefix: PREFIX },
    ]);
    const created = await page.evaluate(async () => {
      const boot = await window.api.data.bootstrap();
      if (!boot.ok) return boot.error;
      const result = await window.api.tickets.create({
        projectId: boot.data.projects[0].id,
        status: "todo",
        title: "Seeded before the check",
        priority: "medium",
      });
      return result.ok ? null : result.error;
    });
    assert.equal(created, null);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await goToBoard(page);
    await cardById(page, `${PREFIX}-1`).waitFor({ timeout: 15000 });
  });
  await close(seed);

  const adopted = await open(config, "adopting launch", CHECK_SEAMS);
  await check("the first window shows the check's page while the check holds", async () => {
    adopted.held = await heldCheckWindow(adopted);
    await adopted.held.page.screenshot({ path: join(scratch, "check-window.png"), timeout: 5000 });
  });
  await check("the same window loads the app once the check answers", async () => {
    const { page, windowId } = adopted.held;
    await release(adopted);
    await page.waitForURL((url) => !isCheckPage(url.href), { timeout: 30000 });
    await page.waitForLoadState("domcontentloaded");
    assertBuiltRendererLoaded(page);
    const shown = await windows(adopted);
    assert.deepEqual(
      shown.map(({ id }) => id),
      [windowId],
      `still the one window: ${JSON.stringify(shown)}`,
    );
    assert.equal(shown[0].visible, true);
  });
  await check("the board works in the adopted window", async () => {
    await assertBoardWorks(adopted, adopted.held.page, {
      number: 2,
      title: "Created in the adopted window",
    });
  });
  await close(adopted);

  const reopened = await open(config, "closed-window launch", CHECK_SEAMS);
  await check("closing the window during the check leaves the launch running", async () => {
    reopened.held = await heldCheckWindow(reopened);
    const closed = reopened.held.page.waitForEvent("close", { timeout: 15000 });
    await bounded("close the check's window", () =>
      reopened.app.evaluate(({ BrowserWindow }, id) => {
        BrowserWindow.fromId(id)?.close();
      }, reopened.held.windowId),
    );
    await closed;
    assert.deepEqual(await windows(reopened), []);
    assert.equal(reopened.app.process().exitCode, null, "the app quit with its window");
  });
  await check("the app opens a new window when ready, and the board works in it", async () => {
    const opened = reopened.app.waitForEvent("window", { timeout: 30000 });
    await release(reopened);
    const page = await opened;
    await page.waitForLoadState("domcontentloaded");
    assertBuiltRendererLoaded(page);
    const shown = await windows(reopened);
    assert.equal(shown.length, 1, `one new window: ${JSON.stringify(shown)}`);
    assert.notEqual(shown[0].id, reopened.held.windowId, "a new window, not the closed one");
    await waitUntil(
      "the new window shown",
      async () => (await windows(reopened))[0]?.visible === true,
      { timeout: 15000, interval: 100 },
    );
    await assertBoardWorks(reopened, page, { number: 3, title: "Created in the new window" });
  });
  await close(reopened);

  console.log(`ALL CHECKS PASSED: ${checks.length} completed checks`);
}

try {
  await main();
  await fs.rm(scratch, { recursive: true, force: true });
} catch (error) {
  console.error(`FAIL: ${error.stack ?? error}`);
  for (const run of runs) {
    for (const [index, page] of run.app.windows().entries())
      await page
        .screenshot({ path: join(scratch, `failure-${run.label}-${index}.png`), timeout: 5000 })
        .catch(() => {});
    if (run.stderr) console.error(`--- ${run.label} stderr (tail) ---\n${run.stderr.slice(-4000)}`);
    await closeAppBounded(run.app).catch(() => {});
  }
  if (scratch) console.error(`evidence kept: ${scratch}`);
  process.exitCode = 1;
}
