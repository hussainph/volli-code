/**
 * VC-1208 / VC-1207: what a quit does while the launch's database worker is
 * inside one long SQLite call, through the built app and a real worker thread.
 *
 * Run after the desktop build:
 *   node apps/desktop/e2e/database-quit-smoke.mjs
 *
 * A small profile's database work answers in milliseconds, so two
 * environment-only seams (`src/main/database-check-smoke.ts`) take this one
 * through a large profile's: every existing file goes to the worker, and the
 * worker counts rows in one read-only SQLite statement before its open, so
 * the quit lands while it is inside a native call. Neither changes what the
 * open does.
 *
 *  1. A seed launch creates the profile, a project and one ticket.
 *  2. A quit during the routine check ends the process within seconds
 *     (`[quit] exit call` says `immediate`), and the database file is
 *     byte-identical, its WAL empty. The next launch opens it.
 *  3. A quit while the automatic backup's worker is inside a long read-only
 *     SQLite call, after boot, with the host's own connection open and a row
 *     written just before: the process ends within seconds, and the next
 *     launch's routine check passes and the row is there.
 *  4. A quit during a schema upgrade (held inside SQLite until this smoke
 *     releases it) keeps the process and its window until the upgrade
 *     returns; the window says the quit waits. A second launch
 *     meanwhile brings the window forward. The process then exits 0, and the
 *     next launch opens the upgraded database, its rows kept.
 *
 * Everything lives under a fresh ignored <workspace>/.tmp/database-quit-*
 * directory. Display required; never builds artifacts.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  APP_DIR,
  ELECTRON,
  REPO,
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  cardById,
  closeAppBounded,
  createDeadline,
  firstAppWindow,
  goToBoard,
  launch,
  launchEnvFor,
  quitEndedByApp,
  makeGitRepo,
  seedProjects,
  smokeExecutableFor,
  waitUntil,
  writeFakeLoginShell,
} from "./lib/smoke-kit.mjs";

const PREFIX = "QUT";
/** Every existing file to the worker; the worker held inside SQLite far longer than any bound here. */
const HELD_CHECK = {
  VOLLI_SMOKE_DATABASE_CHECK_OFF_MAIN_BYTES: "0",
  VOLLI_SMOKE_DATABASE_WORKER_HOLD_ROWS: "100000000000",
};
/** The automatic backup held inside SQLite, its live connection open read-only, far longer than any bound here. */
const HELD_BACKUP = { VOLLI_SMOKE_BACKUP_HOLD_ROWS: "100000000000" };
/** How long a quit during the check may take to end the process (expected: about a second). */
const IMMEDIATE_EXIT_BOUND_MS = 15_000;
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

async function profile(name = "profile") {
  const root = join(scratch, name);
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
  const run = { app, label, userDataDir: config.userDataDir, output: "" };
  runs.add(run);
  const capture = (chunk) => {
    run.output = `${run.output}${chunk}`.slice(-64000);
  };
  app.process().stdout?.on("data", capture);
  app.process().stderr?.on("data", capture);
  await bounded(`${label}: profile isolation`, () =>
    assertProfileIsolated(app, config.userDataDir),
  );
  return run;
}

/**
 * An ordinary quit with no worker left. Electron's own teardown after
 * `app.exit` can outlive it on a loaded machine, and the app's exit watch
 * then ends the process 5 s after the exit call (VC-652). So the quit is
 * bounded by the drain's own deadline (15 s, `quit-gate.ts`), the exit's
 * writes (at most 2 s), the watch's 5 s and a margin: 25 s. Ended by the app
 * either way: exit 0, or the watch's SIGKILL, which its record for the pid confirms.
 */
const ORDINARY_QUIT_MS = 25_000;

async function close(run) {
  const started = Date.now();
  const exit = await closeAppBounded(run.app, { closeGraceMs: ORDINARY_QUIT_MS });
  console.log(`CLEANUP: ${run.label}: ${Date.now() - started} ms ${JSON.stringify(exit)}`);
  runs.delete(run);
  assert.ok(
    quitEndedByApp(exit, run.output, { userDataDir: run.userDataDir }),
    `${run.label} did not quit cleanly`,
  );
}

/** Resolves with the child's exit once it has exited. */
function exitOf(run) {
  const child = run.app.process();
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

/** Asks the app's ordinary quit; the process may be gone before Playwright hears back. */
async function quit(run) {
  await run.app.evaluate(({ app }) => setTimeout(() => app.quit(), 0)).catch(() => {});
}

/** The database file's bytes and stamps, and its WAL's size. */
async function fileState(dbPath) {
  const [bytes, info, wal] = await Promise.all([
    fs.readFile(dbPath),
    fs.stat(dbPath),
    fs.stat(`${dbPath}-wal`).catch(() => null),
  ]);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: info.size,
    mtimeMs: info.mtimeMs,
    walBytes: wal?.size ?? 0,
  };
}

function olderDatabase(command, ...args) {
  const output = execFileSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      join(APP_DIR, "e2e", "lib", "older-database.mjs"),
      command,
      ...args,
    ],
    { cwd: REPO, encoding: "utf8" },
  );
  return JSON.parse(output.trim().split("\n").at(-1));
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

async function statusPage(run, label) {
  const page = await bounded(`${run.label}: first window`, () => run.app.firstWindow(), 30000);
  await page.getByRole("status").getByText(label, { exact: true }).waitFor({ timeout: 30000 });
  return page;
}

/** Writes one ticket through the window's bridge; resolves with null or the error. */
function createTicket(page, title) {
  return page.evaluate(async (ticketTitle) => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) return boot.error;
    const result = await window.api.tickets.create({
      projectId: boot.data.projects[0].id,
      status: "todo",
      title: ticketTitle,
      priority: "medium",
    });
    return result.ok ? null : result.error;
  }, title);
}

/** Resolves once the backup's worker has marked its hold (`held`, beside its snapshot). */
async function heldBackup(userDataDir) {
  const directory = join(userDataDir, "backups");
  return waitUntil(
    "the automatic backup held inside SQLite",
    async () => {
      const names = await fs.readdir(directory).catch(() => []);
      for (const name of names.filter((entry) => entry.startsWith(".automatic-"))) {
        if (await fs.stat(join(directory, name, "held")).catch(() => null)) return true;
      }
      return false;
    },
    { timeout: 60000, interval: 100 },
  );
}

async function boardHasSeed(run) {
  const page = await firstAppWindow(run.app, { timeout: 60000 });
  await page.waitForLoadState("domcontentloaded");
  assertBuiltRendererLoaded(page);
  await goToBoard(page);
  await cardById(page, `${PREFIX}-1`).waitFor({ timeout: 15000 });
}

async function main() {
  await fs.mkdir(join(REPO, ".tmp"), { recursive: true });
  scratch = await fs.mkdtemp(join(REPO, ".tmp", "database-quit-"));
  const config = await profile();
  const repo = await makeGitRepo(scratch);

  const seed = await open(config, "seed launch");
  await check("a fresh profile boots with a project and one ticket", async () => {
    const page = await firstAppWindow(seed.app, { timeout: 30000 });
    await page.waitForLoadState("domcontentloaded");
    assertBuiltRendererLoaded(page);
    await seedProjects(page, [
      { id: "database-quit-project", name: "Database Quit", path: repo, prefix: PREFIX },
    ]);
    const created = await page.evaluate(async () => {
      const boot = await window.api.data.bootstrap();
      if (!boot.ok) return boot.error;
      const result = await window.api.tickets.create({
        projectId: boot.data.projects[0].id,
        status: "todo",
        title: "Seeded before the quit",
        priority: "medium",
      });
      return result.ok ? null : result.error;
    });
    assert.equal(created, null);
  });
  await close(seed);

  const before = await fileState(config.dbPath);
  const checking = await open(config, "held check", HELD_CHECK);
  await check(
    "a quit during the check ends the process at once, the database untouched",
    async () => {
      await statusPage(checking, "Checking your data");
      const exited = exitOf(checking);
      const asked = Date.now();
      await quit(checking);
      const exit = await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve(null), IMMEDIATE_EXIT_BOUND_MS)),
      ]);
      const quitMs = Date.now() - asked;
      assert.ok(exit !== null, `the process outlived the quit by ${IMMEDIATE_EXIT_BOUND_MS} ms`);
      runs.delete(checking);
      console.log(
        `quit during the check: process gone ${quitMs} ms after the quit; ${JSON.stringify(exit)}`,
      );
      assert.deepEqual(exit, { code: null, signal: "SIGKILL" }, "ended by the app's own exit");
      assert.match(checking.output, /\[quit\] exit call \{[^}]*mode: 'immediate'/s);
      assert.deepEqual(
        await fileState(config.dbPath),
        before,
        "the database file is byte-identical",
      );
    },
  );

  const after = await open(config, "launch after the killed check");
  await check("the next launch opens the database and the board", async () => {
    await boardHasSeed(after);
  });
  await close(after);

  // A fresh profile: its first launch starts the automatic backup at boot.
  const backupConfig = await profile("backup-profile");
  const backupRepo = await makeGitRepo(scratch, "backup-project-");
  const backingUp = await open(backupConfig, "held backup", HELD_BACKUP);
  await check(
    "a quit while the backup is inside SQLite, the host's connection open, ends the process at once",
    async () => {
      const page = await firstAppWindow(backingUp.app, { timeout: 60000 });
      await page.waitForLoadState("domcontentloaded");
      assertBuiltRendererLoaded(page);
      await seedProjects(page, [
        { id: "backup-quit-project", name: "Backup Quit", path: backupRepo, prefix: "BKP" },
      ]);
      await heldBackup(backupConfig.userDataDir);
      assert.equal(await createTicket(page, "Written just before the quit"), null);
      const exited = exitOf(backingUp);
      const asked = Date.now();
      await quit(backingUp);
      const exit = await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve(null), IMMEDIATE_EXIT_BOUND_MS)),
      ]);
      const quitMs = Date.now() - asked;
      assert.ok(exit !== null, `the process outlived the quit by ${IMMEDIATE_EXIT_BOUND_MS} ms`);
      runs.delete(backingUp);
      console.log(
        `quit during the backup: process gone ${quitMs} ms after the quit; ${JSON.stringify(exit)}`,
      );
      assert.deepEqual(exit, { code: null, signal: "SIGKILL" }, "ended by the app's own exit");
      assert.match(
        backingUp.output,
        /\[quit\] exit call \{[^}]*mode: 'immediate'[^}]*liveWorkers: 1/s,
      );
      // Killed with the host's connection open: its last commits are still in the WAL.
      const wal = await fs.stat(`${backupConfig.dbPath}-wal`).catch(() => null);
      console.log(`WAL left by the killed process: ${wal?.size ?? 0} bytes`);
      assert.ok((wal?.size ?? 0) > 0, "the WAL holds the last commits");
    },
  );
  const afterBackup = await open(backupConfig, "launch after the killed backup", {
    VOLLI_SMOKE_DATABASE_CHECK_OFF_MAIN_BYTES: "0",
  });
  await check(
    "the next launch's check passes, and the row written before the quit is there",
    async () => {
      const page = await firstAppWindow(afterBackup.app, { timeout: 60000 });
      await page.waitForLoadState("domcontentloaded");
      assertBuiltRendererLoaded(page);
      await goToBoard(page);
      await cardById(page, "BKP-1")
        .filter({ hasText: "Written just before the quit" })
        .waitFor({ timeout: 15000 });
      assert.match(
        afterBackup.output,
        /\[desktop\] database check finished \{[^}]*outcome: 'clean'/s,
      );
    },
  );
  await close(afterBackup);

  const { fromVersion, head } = olderDatabase("write", join(scratch, "older.db"), "2");
  for (const suffix of ["", "-wal", "-shm"])
    await fs.rm(`${config.dbPath}${suffix}`, { force: true });
  await fs.copyFile(join(scratch, "older.db"), config.dbPath);
  // Held inside SQLite until this smoke creates the release file.
  const release = join(scratch, "release-upgrade");
  const upgrading = await open(config, "held upgrade", {
    VOLLI_SMOKE_DATABASE_WORKER_HOLD_UNTIL: release,
  });
  let windowId;
  await check("a quit during an upgrade keeps the process and a window saying so", async () => {
    const page = await statusPage(upgrading, "Updating your data");
    await quit(upgrading);
    await page
      .getByRole("status")
      .getByText("Updating your data before quitting", { exact: true })
      .waitFor({ timeout: 15000 });
    const shown = await windows(upgrading);
    assert.equal(shown.length, 1, `one window while the quit waits: ${JSON.stringify(shown)}`);
    assert.equal(shown[0].visible, true);
    assert.equal(upgrading.app.process().exitCode, null, "the process waits for the upgrade");
    windowId = shown[0].id;
  });
  await check("a second launch meanwhile brings the waiting window forward", async () => {
    await bounded("hide the waiting window", () =>
      upgrading.app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.hide(), windowId),
    );
    const environment = launchEnvFor(config.dbPath, config.extraEnv);
    const second = spawn(
      smokeExecutableFor(ELECTRON, config.userDataDir, { environment }),
      [
        APP_DIR,
        `--user-data-dir=${config.userDataDir}`,
        "--use-mock-keychain",
        "--password-store=basic",
      ],
      { env: environment, stdio: "ignore" },
    );
    const secondExit = new Promise((resolve) => second.once("exit", (code) => resolve(code)));
    await waitUntil(
      "the waiting window shown again",
      async () => (await windows(upgrading)).find(({ id }) => id === windowId)?.visible === true,
      { timeout: 30000, interval: 100 },
    );
    assert.equal(await bounded("the second launch exits", () => secondExit, 30000), 0);
    assert.equal(upgrading.app.process().exitCode, null, "still waiting for the upgrade");
  });
  await check("the upgrade finishes, then the process exits 0", async () => {
    await fs.writeFile(release, "");
    const exit = await bounded("the held quit", () => exitOf(upgrading), 600_000);
    runs.delete(upgrading);
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.match(upgrading.output, /\[quit\] quit waits for the database upgrade/);
    assert.match(upgrading.output, /\[quit\] exit call \{[^}]*mode: 'normal'/s);
    assert.deepEqual(olderDatabase("read", config.dbPath), { version: head, probe: "kept" });
    assert.ok(fromVersion < head);
  });

  const upgraded = await open(config, "launch after the upgrade");
  await check("the next launch opens the upgraded database", async () => {
    const page = await firstAppWindow(upgraded.app, { timeout: 60000 });
    await page.waitForLoadState("domcontentloaded");
    assertBuiltRendererLoaded(page);
    const boot = await bounded("bootstrap", () =>
      page.evaluate(async () => (await window.api.data.bootstrap()).ok),
    );
    assert.equal(boot, true, "the upgraded database serves the app");
  });
  await close(upgraded);

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
    if (run.output) console.error(`--- ${run.label} output (tail) ---\n${run.output.slice(-4000)}`);
    await closeAppBounded(run.app).catch(() => {});
  }
  if (scratch) console.error(`evidence kept: ${scratch}`);
  process.exitCode = 1;
}
