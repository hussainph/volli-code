/**
 * smoke-kit — shared machinery for Volli's manually-run Playwright e2e smokes.
 *
 * The existing smokes (board-smoke.mjs, ticket-detail-smoke.mjs, …) each
 * copy-pasted the same boot/launch/attempt scaffolding. This module extracts the
 * common parts so new probes stop duplicating them:
 *
 *   • paths          — REPO / APP_DIR / ELECTRON resolved once.
 *   • makeScratch()  — an isolated scratch dir + user-data dir + scratch DB path,
 *                      with `ownsScratch`/cleanup honouring VOLLI_SMOKE_DIR.
 *   • launch()       — launch the BUILT Electron app against a scratch
 *                      VOLLI_DB_PATH + isolated --user-data-dir, extra env merged
 *                      over process.env. Skips the PTY-busy close confirm.
 *   • createRunner() — the numbered attempt()/check() runner + summary/exit-code,
 *                      identical semantics to the inline harness the smokes use
 *                      (a failed check never aborts the run).
 *   • waitUntil()/sleep()/readFileSafe()/pathExists() — polling helpers; probes
 *                      poll for conditions, they never bare-sleep for a state.
 *   • makeGitRepo()  — `git init` + an initial commit in a temp dir, so the
 *                      project path is a real repo worktree creation can branch
 *                      from (the kickoff flow makes a worktree).
 *   • seedProjects() — seed one or more projects the way the existing smokes do:
 *                      write the legacy `volli:projects` localStorage envelope and
 *                      reload, letting boot()'s first-run import land them in
 *                      SQLite. (Driving the native folder picker isn't feasible
 *                      under Playwright; this is the established seeding path — see
 *                      board-smoke.mjs / global-artifacts-smoke.mjs.)
 *   • cardById()/columnCount() — the board DOM readers both composer probes need.
 *
 * These smokes are NOT wired into `vp test`; they need a display + the built app.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { _electron } from "playwright-core";

const execFileAsync = promisify(execFile);

// ---- paths -----------------------------------------------------------------

/** Repo root — this file lives at apps/desktop/e2e/lib/, so up four levels. */
export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const APP_DIR = join(REPO, "apps", "desktop");
export const ELECTRON = join(
  APP_DIR,
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
  "Contents",
  "MacOS",
  "Electron",
);

// ---- scratch dirs ----------------------------------------------------------

/**
 * Allocate an isolated scratch tree for one smoke run. Honours VOLLI_SMOKE_DIR
 * (reuse an externally-provided dir and do NOT clean it up); otherwise mkdtemp's
 * a fresh one that `cleanup()` removes.
 *
 * @param {string} prefix  os.tmpdir() mkdtemp prefix, e.g. "volli-composer-smoke-".
 * @returns {Promise<{scratch:string, userDataDir:string, dbPath:string,
 *                     ownsScratch:boolean, cleanup:() => Promise<void>}>}
 */
export async function makeScratch(prefix) {
  const ownsScratch = process.env.VOLLI_SMOKE_DIR === undefined;
  const scratch = process.env.VOLLI_SMOKE_DIR ?? (await fs.mkdtemp(join(os.tmpdir(), prefix)));
  const userDataDir = join(scratch, "user-data");
  const dbPath = join(scratch, "volli.db");
  await fs.mkdir(userDataDir, { recursive: true });
  return {
    scratch,
    userDataDir,
    dbPath,
    ownsScratch,
    cleanup: async () => {
      if (ownsScratch) await fs.rm(scratch, { recursive: true, force: true });
    },
  };
}

// ---- launch ----------------------------------------------------------------

/**
 * Launch the built app against a scratch DB + isolated profile. `extraEnv` is
 * merged over process.env (the child keeps PATH etc. unless overridden — the
 * kickoff smoke overrides PATH/ZDOTDIR here to install its fake harness).
 * VOLLI_SKIP_CLOSE_CONFIRM=1 stops a PTY-busy close from hanging the run.
 *
 * @param {{dbPath:string, userDataDir:string, extraEnv?:Record<string,string>}} opts
 */
export function launch({ dbPath, userDataDir, extraEnv = {} }) {
  return _electron.launch({
    executablePath: ELECTRON,
    args: [APP_DIR, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      VOLLI_DB_PATH: dbPath,
      VOLLI_SKIP_CLOSE_CONFIRM: "1",
      ...extraEnv,
    },
  });
}

/**
 * Assert the launched app really used our isolated profile (a leaked default
 * profile would corrupt the developer's real data). Throws on mismatch.
 */
export async function assertProfileIsolated(app, userDataDir) {
  const actualUserDataDir = await app.evaluate(({ app: electronApp }) =>
    electronApp.getPath("userData"),
  );
  const [actual, expected] = await Promise.all([
    fs.realpath(actualUserDataDir),
    fs.realpath(userDataDir),
  ]);
  if (actual !== expected) {
    throw new Error(`smoke profile is not isolated: expected ${expected}, got ${actual}`);
  }
}

// ---- numbered check runner -------------------------------------------------

/**
 * The attempt()/check() harness the smokes share: each numbered check records a
 * PASS/FAIL line and never throws (a thrown body fails just that check). Call
 * `summarize()` at the end for the roll-up line + process exit code.
 *
 * @returns {{results:{n:number|string, ok:boolean}[],
 *            check:(n:any,label:string,ok:boolean,detail?:string)=>void,
 *            attempt:(n:any,label:string,fn:()=>Promise<{ok:boolean,detail?:string}>)=>Promise<void>,
 *            summarize:()=>number}}
 */
export function createRunner() {
  const results = [];
  function check(n, label, ok, detail = "") {
    const status = ok ? "PASS" : "FAIL";
    results.push({ n, ok });
    console.log(`  [${status}] ${n}. ${label}${detail ? ` — ${detail}` : ""}`);
  }
  async function attempt(n, label, fn) {
    try {
      const { ok, detail } = await fn();
      check(n, label, ok, detail);
    } catch (error) {
      check(n, label, false, `threw: ${error?.message ?? error}`);
    }
  }
  function summarize() {
    const failures = results.filter((r) => !r.ok);
    console.log(
      `\n${
        failures.length === 0
          ? "ALL CHECKS PASSED"
          : `${failures.length} CHECK(S) FAILED: ${failures.map((f) => f.n).join(", ")}`
      }`,
    );
    return failures.length === 0 ? 0 : 1;
  }
  return { results, check, attempt, summarize };
}

// ---- polling helpers -------------------------------------------------------

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `fn` until it returns a truthy value (returned to the caller) or the
 * timeout elapses (throws with `label` + the last value/error). The one waiting
 * primitive probes use instead of fixed sleeps.
 */
export async function waitUntil(label, fn, { timeout = 12000, interval = 150 } = {}) {
  const start = Date.now();
  let lastErr = null;
  let lastVal;
  while (Date.now() - start < timeout) {
    try {
      lastVal = await fn();
      if (lastVal) return lastVal;
    } catch (error) {
      lastErr = error;
    }
    await sleep(interval);
  }
  const tail = lastErr
    ? `last error: ${lastErr.message}`
    : `last value: ${JSON.stringify(lastVal)}`;
  throw new Error(`timed out waiting for ${label} (${tail})`);
}

export async function readFileSafe(path) {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function pathExists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

// ---- project seeding -------------------------------------------------------

/**
 * `git init` a real, writable repo in a fresh temp dir under `parentDir`, with an
 * initial commit so `git worktree add` (the kickoff flow) has a base to branch
 * from. Returns the realpath'd dir (macOS temp dirs are symlinked; the shell's
 * $PWD and node's resolve() must agree with the seeded project path).
 *
 * @param {string} parentDir  A scratch dir to mkdtemp the repo inside.
 * @param {string} [name]     mkdtemp prefix (default "project-").
 * @returns {Promise<string>} Absolute, realpath'd repo path.
 */
export async function makeGitRepo(parentDir, name = "project-") {
  const dir = await fs.realpath(await fs.mkdtemp(join(parentDir, name)));
  const run = (args) => execFileAsync("git", args, { cwd: dir });
  await run(["init", "-q"]);
  // Local identity so the initial commit works even on a machine with no global
  // git user configured.
  await run(["config", "user.email", "smoke@volli.test"]);
  await run(["config", "user.name", "Volli Smoke"]);
  await fs.writeFile(join(dir, "README.md"), "# smoke project\n");
  await run(["add", "-A"]);
  await run(["commit", "-q", "-m", "initial commit"]);
  return dir;
}

/**
 * Seed one or more projects the way the existing smokes do: write the legacy
 * `volli:projects` zustand envelope into localStorage, then reload so boot()'s
 * first-run import lands them in SQLite. The first project is selected. Each
 * `projects[i]` is `{ id, name, path, prefix, colorIndex? }`.
 *
 * (Playwright can't drive the app's native folder-picker dialog, so this
 * envelope-then-import path — used verbatim by board-smoke / global-artifacts —
 * is the established, deterministic way to get projects into a scratch profile.)
 *
 * @param {import("playwright-core").Page} page
 * @param {{id:string,name:string,path:string,prefix:string,colorIndex?:number}[]} projects
 * @param {{reloadWaitMs?:number}} [opts]
 */
export async function seedProjects(page, projects, { reloadWaitMs = 1500 } = {}) {
  await page.evaluate((list) => {
    localStorage.setItem(
      "volli:projects",
      JSON.stringify({
        state: {
          projects: list.map((p, index) => ({
            id: p.id,
            name: p.name,
            path: p.path,
            ticketPrefix: p.prefix,
            colorIndex: p.colorIndex ?? index,
            createdAt: Date.now(),
          })),
          selectedProjectId: list[0]?.id ?? null,
        },
        version: 1,
      }),
    );
  }, projects);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await sleep(reloadWaitMs);
}

/**
 * Resolve the imported projects from the SQLite snapshot (post-seed), keyed by
 * name → project row (so a probe can grab a project's real UUID / prefix without
 * assuming ordering). Returns `{ projects, byName }`.
 */
export async function readSeededProjects(page) {
  return page.evaluate(async () => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) throw new Error(`bootstrap: ${boot.error}`);
    const byName = {};
    for (const p of boot.data.projects) byName[p.name] = p;
    return { projects: boot.data.projects, byName };
  });
}

// ---- board DOM readers -----------------------------------------------------

/** The single board `<article>` whose mono id span equals `id` exactly. */
export function cardById(page, id) {
  const exact = new RegExp(`^${id}$`);
  return page
    .locator("article")
    .filter({ has: page.locator("span.font-mono", { hasText: exact }) });
}

/**
 * The count next to an expanded column's header label (e.g. Backlog's "3"), or
 * null when that label is a collapsed rail pill rather than a mounted column.
 * (Same reader board-smoke uses — a column body and its pill are never both
 * mounted.)
 */
export async function columnCount(page, label) {
  return page.evaluate((columnLabel) => {
    const headers = Array.from(document.querySelectorAll("div.flex.items-center.gap-2"));
    const header = headers.find((div) => {
      const first = div.children[0];
      return first?.tagName === "SPAN" && first.textContent === columnLabel;
    });
    const countSpan = header?.children[1];
    if (!countSpan) return null;
    const n = Number(countSpan.textContent.trim());
    return Number.isNaN(n) ? null : n;
  }, label);
}

/** Whether an expanded board column (by header label) contains a card with mono id `id`. */
export async function columnHasCard(page, label, id) {
  return page.evaluate(
    ({ columnLabel, cardId }) => {
      const headers = Array.from(document.querySelectorAll("div.flex.items-center.gap-2"));
      const header = headers.find((div) => {
        const first = div.children[0];
        return first?.tagName === "SPAN" && first.textContent === columnLabel;
      });
      const ids = Array.from(
        header?.parentElement?.querySelectorAll("article span.font-mono") ?? [],
      );
      return ids.some((span) => span.textContent?.trim() === cardId);
    },
    { columnLabel: label, cardId: id },
  );
}

/** Click the Board nav item if present, then settle — robust across reloads. */
export async function goToBoard(page) {
  const boardNav = page.getByRole("button", { name: "Board", exact: true });
  if (await boardNav.count()) await boardNav.first().click();
  await sleep(400);
}
