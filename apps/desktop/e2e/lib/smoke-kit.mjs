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
 *                      VOLLI_DB_PATH + isolated --user-data-dir + worktree home,
 *                      with extra env merged over process.env, while stripping
 *                      inherited Electron dev-mode switches. Skips the PTY-busy
 *                      close confirm.
 *   • createRunner() — the numbered attempt()/check()/must() runner +
 *                      summary/exit-code,
 *                      attempt/check failures remain non-aborting; must prints
 *                      the summary and stops dependent actions.
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
 *   • ensurePiAuthInto() — copies the real `~/.pi/agent/auth.json` into a smoke's
 *                      isolated HOME, so a live Pi turn is possible without
 *                      touching the developer's own profile.
 *   • seedDefaultModel() — records the app-wide default model every structured
 *                      Session (Ticket or Project) now requires before it can
 *                      start, over the same `modelAccess.setDefault` tRPC
 *                      mutation Settings uses. Needs real Pi credentials
 *                      already readable, so callers run it after seeding those.
 *                      Takes an optional pin so a probe can name the model it
 *                      claims to test instead of inheriting the catalog's first.
 *   • assistantReplyTexts()/waitForSettledReply()/PI_TURN_BUDGET_MS — the ONE
 *                      encoding of "this turn produced an answer": what counts
 *                      as assistant PROSE (not a tool bundle), and how long a
 *                      real turn gets. Every Pi smoke waits through these.
 *   • readMonacoState()/isMonacoEditable() — the ONE encoding of how to
 *                      interrogate this Monaco build (input surface, read-only
 *                      contract, rendered aria-label), shared by every probe
 *                      that opens an editor.
 *   • monacoEditor()/clickMonaco()/readMonacoText()/typeIntoMonaco() — the same
 *                      encoding, scoped to one host, for surfaces that mount
 *                      several editors. Typing is click-then-keyboard (Monaco's
 *                      input surface is not a textarea): clickMonaco polls
 *                      `data-monaco-status === "ready"` before focusing, and
 *                      typeIntoMonaco always waits for the characters to land.
 *   • readDocumentLine()/readDocumentView() — Document Mode's rendered text split
 *                      into what is SEEN and what is COLLAPSED, by COMPUTED
 *                      STYLE. textContent still returns `display:none` text, so
 *                      it cannot answer "is this delimiter visible?".
 *   • cardById()/columnCount() — the board DOM readers both composer probes need.
 *   • startTerminalSession() — the ONE encoding of "start a terminal from this
 *                      surface's session-start control", which is a split
 *                      button: chat on the press, terminal behind the caret.
 *
 * These smokes are NOT wired into `vp test`; they need a display + the built app.
 */
import { execFile } from "node:child_process";
import { promises as fs, rmSync } from "node:fs";
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
 *
 * Every launch defaults VOLLI_WORKTREE_HOME_DIR to a directory alongside the
 * scratch DB. Worktree-creating probes must never inherit the developer's
 * real home directory: cleanup() owns the scratch tree and removes every
 * fixture checkout with it. A probe can still supply an explicit alternate
 * root through extraEnv when it needs to assert a particular layout.
 * VOLLI_SKIP_CLOSE_CONFIRM=1 stops a PTY-busy close from hanging the run.
 *
 * @param {string} dbPath
 * @param {Record<string,string>} [extraEnv]
 */
export function worktreeHomeFor(dbPath, extraEnv = {}) {
  return extraEnv.VOLLI_WORKTREE_HOME_DIR ?? join(dirname(dbPath), "worktree-home");
}

/**
 * Build the environment passed to Electron. Dev-only renderer/runtime switches
 * are removed after `extraEnv` is merged so no caller can accidentally turn a
 * built smoke back into a dev-server launch.
 *
 * @param {string} dbPath
 * @param {Record<string,string>} [extraEnv]
 */
export function launchEnvFor(dbPath, extraEnv = {}) {
  const env = {
    ...process.env,
    VOLLI_DB_PATH: dbPath,
    VOLLI_SKIP_CLOSE_CONFIRM: "1",
    ...extraEnv,
    VOLLI_WORKTREE_HOME_DIR: worktreeHomeFor(dbPath, extraEnv),
  };
  delete env.ELECTRON_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * `VOLLI_SMOKE_APP_BINARY` points every smoke at a PACKAGED app binary
 * (`…/Volli.app/Contents/MacOS/Volli`) instead of the dev Electron + source
 * dir — the H2 lane. Electron itself honours `--user-data-dir`, so profile
 * isolation carries over; `VOLLI_DB_PATH` does NOT (dev-gated in
 * `main/index.ts`), so in packaged mode the DB lands at `<userData>/volli.db`
 * — a smoke that reads `dbPath` directly cannot run in this mode unchanged.
 *
 * @param {{dbPath:string, userDataDir:string, extraEnv?:Record<string,string>}} opts
 */
export function launch({ dbPath, userDataDir, extraEnv = {} }) {
  const packagedBinary = process.env.VOLLI_SMOKE_APP_BINARY;
  return _electron.launch({
    executablePath: packagedBinary ?? ELECTRON,
    args: packagedBinary
      ? [`--user-data-dir=${userDataDir}`]
      : [APP_DIR, `--user-data-dir=${userDataDir}`],
    env: launchEnvFor(dbPath, extraEnv),
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

const BUILT_RENDERER_ENTRY_URL = "volli-app://bundle/index.html";

/**
 * Assert the launched main window loaded the built renderer rather than an
 * inherited Vite dev-server URL. Call after the window reaches DOMContentLoaded.
 *
 * @param {import("playwright-core").Page} page
 */
export function assertBuiltRendererLoaded(page) {
  const actual = page.url();
  if (actual !== BUILT_RENDERER_ENTRY_URL) {
    throw new Error(
      `smoke did not load the built renderer: expected ${BUILT_RENDERER_ENTRY_URL}, got ${actual}`,
    );
  }
}

// ---- numbered check runner -------------------------------------------------

/**
 * The attempt()/check() harness the smokes share: each numbered check records a
 * PASS/FAIL line and never throws (a thrown body fails just that check). `must()`
 * adds fail-fast sequencing for dependent actions and prints the roll-up before
 * throwing. Call `summarize()` at the end for the normal roll-up + exit code.
 *
 * @returns {{results:{n:number|string, ok:boolean}[],
 *            check:(n:any,label:string,ok:boolean,detail?:string)=>void,
 *            attempt:(n:any,label:string,fn:()=>Promise<{ok:boolean,detail?:string}>)=>Promise<void>,
 *            must:(n:any,label:string,fn:()=>Promise<{ok:boolean,detail?:string}>)=>Promise<void>,
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
  async function must(n, label, fn) {
    const resultIndex = results.length;
    await attempt(n, label, fn);
    if (results[resultIndex]?.ok === true) return;

    summarize();
    throw new Error(`required check ${n} failed; refusing dependent smoke actions`);
  }
  return { results, check, attempt, must, summarize };
}

// ---- polling helpers -------------------------------------------------------

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const CLOSE_APP_BOUNDED_DEFAULTS = Object.freeze({
  closeGraceMs: 2500,
  termGraceMs: 1500,
  killGraceMs: 1500,
  naturalExitRaceMs: 500,
});

/**
 * The longest default close path: close timeout, a resolved-without-exit race,
 * then TERM and KILL.
 */
export const CLOSE_APP_BOUNDED_MAX_MS =
  CLOSE_APP_BOUNDED_DEFAULTS.closeGraceMs +
  CLOSE_APP_BOUNDED_DEFAULTS.naturalExitRaceMs +
  CLOSE_APP_BOUNDED_DEFAULTS.termGraceMs +
  CLOSE_APP_BOUNDED_DEFAULTS.killGraceMs;

/** @typedef {number | ReturnType<typeof setTimeout>} DeadlineTimerHandle */

/**
 * Build one absolute operation budget. `run()` is the aggregate watchdog;
 * `timeout()` derives shorter per-action locator clamps from the same expiry.
 * The injectable clock keeps the race deterministic under node:test.
 *
 * @param {{label:string, expiresAt:number, timeoutCeilingMs?:number,
 *          clock?:{now?:()=>number,
 *                  setTimeout?:(callback:()=>void, delay:number)=>DeadlineTimerHandle,
 *                  clearTimeout?:(timer:DeadlineTimerHandle)=>void}}} options
 */
export function createDeadline({
  label,
  expiresAt,
  timeoutCeilingMs = 2000,
  clock: clockOverrides = {},
}) {
  const clock = {
    now: clockOverrides.now ?? Date.now,
    setTimeout: clockOverrides.setTimeout ?? setTimeout,
    clearTimeout: clockOverrides.clearTimeout ?? clearTimeout,
  };
  const remaining = (actionLabel) => {
    const remainingMs = expiresAt - clock.now();
    if (remainingMs <= 0) {
      throw new Error(`${label} deadline expired${actionLabel ? ` during ${actionLabel}` : ""}`);
    }
    return remainingMs;
  };
  return Object.freeze({
    label,
    expiresAt,
    timeout(actionLabel, ceiling = timeoutCeilingMs) {
      return Math.min(ceiling, remaining(actionLabel));
    },
    async run(operation) {
      const remainingMs = remaining();
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(operation),
          new Promise((_, reject) => {
            timer = clock.setTimeout(
              () => reject(new Error(`${label} deadline expired`)),
              remainingMs,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clock.clearTimeout(timer);
      }
    },
  });
}

/**
 * Summarize lifecycle frames while preserving their runtime turn identity.
 * Exactly-once means one started id, one matching completed id, and no
 * interruption — counts alone cannot correlate two different turns.
 *
 * @param {{event?:{payload?:{kind?:string,turnId?:unknown}}}[]} frames
 */
export function summarizeTurnFrames(frames) {
  const idsFor = (kind) =>
    frames
      .filter((frame) => frame.event?.payload?.kind === kind)
      .map((frame) =>
        typeof frame.event.payload.turnId === "string" ? frame.event.payload.turnId : null,
      );
  const startedIds = idsFor("turn.started");
  const completedIds = idsFor("turn.completed");
  const interruptedIds = idsFor("turn.interrupted");
  return {
    startedIds,
    completedIds,
    interruptedIds,
    exactlyOneCompletedTurn:
      startedIds.length === 1 &&
      completedIds.length === 1 &&
      interruptedIds.length === 0 &&
      startedIds[0] !== null &&
      startedIds[0] === completedIds[0],
  };
}

/**
 * Close Electron within bounded grace periods and return how the tracked main
 * child exited. Every successful return is backed by observed ChildProcess exit
 * fields; an unverified live child throws instead of being mistaken for cleanup.
 *
 * Signals target only `app.process()`'s exact child, never a process group. This
 * proves the Electron main child is gone, not that an already-reparented helper
 * also exited; graceful Electron shutdown remains the helper cleanup path.
 */
export async function closeAppBounded(app, options = {}) {
  const { closeGraceMs, termGraceMs, killGraceMs, naturalExitRaceMs } = {
    ...CLOSE_APP_BOUNDED_DEFAULTS,
    ...options,
  };
  let child;
  try {
    child = app.process();
  } catch (error) {
    throw new Error("cannot inspect Electron main child before bounded close", { cause: error });
  }

  const pid = child.pid ?? "unknown";
  const closeFailures = [];
  const result = (kind, exit) => ({ kind, pid, exit, closeFailures: [...closeFailures] });
  const observedExit = () => ({ code: child.exitCode, signal: child.signalCode });
  const waitForExit = async (label, timeout) => {
    try {
      // A failed kill gets a deliberately short natural-exit grace. Poll it
      // more often than that grace or an exit can happen during the first
      // sleep and be mistaken for an ignored signal.
      return await waitForChildExit(child, label, {
        timeout,
        interval: Math.max(1, Math.min(20, Math.floor(timeout / 4))),
      });
    } catch {
      return null;
    }
  };
  const signalAndWait = async (signal, graceMs) => {
    let sent = false;
    let error = null;
    try {
      sent = child.kill(signal);
    } catch (cause) {
      error = cause;
    }
    if (childHasExited(child)) return { sent, error, exit: observedExit() };
    const exit = await waitForExit(
      `${sent ? signal : "natural"} Electron pid ${pid} exit`,
      sent ? graceMs : naturalExitRaceMs,
    );
    return { sent, error, exit };
  };
  if (childHasExited(child)) return result("already-exited", observedExit());

  let closeTimer;
  const closeAttempt = await Promise.race([
    app.close().then(
      () => ({ status: "resolved" }),
      (error) => ({ status: "rejected", error }),
    ),
    new Promise((resolve) => {
      closeTimer = setTimeout(() => resolve({ status: "timed-out" }), closeGraceMs);
    }),
  ]);
  clearTimeout(closeTimer);

  if (closeAttempt.status === "resolved") {
    const exit = await waitForExit(`graceful Electron pid ${pid} exit`, naturalExitRaceMs);
    if (exit) return result("graceful", exit);
    closeFailures.push("app.close resolved without observed exit");
  } else if (closeAttempt.status === "rejected") {
    closeFailures.push(`app.close rejected: ${closeAttempt.error?.message ?? closeAttempt.error}`);
  } else {
    closeFailures.push(`app.close timed out after ${closeGraceMs}ms`);
  }

  if (childHasExited(child)) return result("natural-after-close", observedExit());

  const term = await signalAndWait("SIGTERM", termGraceMs);
  if (term.exit) return result(term.sent ? "sigterm" : "natural-after-close", term.exit);
  closeFailures.push(
    term.error
      ? `SIGTERM failed: ${term.error?.message ?? term.error}`
      : term.sent
        ? `SIGTERM exit timed out after ${termGraceMs}ms`
        : "SIGTERM was not delivered to the live child",
  );

  const kill = await signalAndWait("SIGKILL", killGraceMs);
  if (kill.exit) return result(kill.sent ? "sigkill" : "natural-after-sigterm", kill.exit);
  const message =
    kill.error?.code === "ESRCH"
      ? `Electron pid ${pid} remained live after SIGKILL reported ESRCH`
      : kill.error
        ? `failed to SIGKILL Electron pid ${pid}`
        : kill.sent
          ? `Electron pid ${pid} remained live after SIGKILL`
          : `SIGKILL was not delivered to live Electron pid ${pid}`;
  throw new Error(message, kill.error ? { cause: kill.error } : undefined);
}

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

/** @param {import("node:child_process").ChildProcess} child */
export function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Wait for Node's ChildProcess exit fields to reflect the actual process exit.
 * Those fields can briefly lag an OS-level ESRCH/failed kill result.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {string} label
 * @param {{timeout?:number, interval?:number}} [opts]
 */
export function waitForChildExit(child, label, opts) {
  return waitUntil(
    label,
    async () => (childHasExited(child) ? { code: child.exitCode, signal: child.signalCode } : null),
    opts,
  );
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

// ---- Pi credentials ----------------------------------------------------------

/**
 * Where a real `pi` login puts its credentials on this machine.
 *
 * Module-private: it was exported while each smoke staged its own copy, and
 * nothing outside this file needs a path to the developer's live token now that
 * one helper does the staging. Narrowing it is the point rather than tidiness —
 * the fewer callers that can name this file, the fewer that can copy it.
 */
const REAL_PI_AUTH = join(os.homedir(), ".pi", "agent", "auth.json");

/**
 * Copy the real Pi credentials into an isolated `HOME`, so a smoke can drive a
 * live turn without ever touching the developer's own profile.
 *
 * Pi's credential store reads `$PI_CODING_AGENT_DIR` else `~/.pi/agent/auth.json`
 * under whatever `HOME` the process was launched with
 * (`packages/agent-runtime/src/pi/models.ts`), so a smoke that overrides `HOME`
 * — the same posture `VOLLI_WORKTREE_HOME_DIR` takes for worktrees — has to put
 * a copy there first or the app boots into a login-required dead end.
 *
 * Never reads or prints the contents: `fs.copyFile`, byte for byte. Fails fast
 * with a message naming the missing file rather than letting the app start.
 *
 * @param {string} homeDir  The isolated HOME the app will be launched with.
 */
export async function ensurePiAuthInto(homeDir) {
  if (!(await pathExists(REAL_PI_AUTH))) {
    throw new Error(
      `Real Pi credentials not found at ${REAL_PI_AUTH}. This smoke drives a live Pi turn and ` +
        "needs a working `pi` login (openai-codex / ChatGPT subscription) on this machine first.",
    );
  }
  const dest = join(homeDir, ".pi", "agent", "auth.json");
  await fs.mkdir(dirname(dest), { recursive: true, mode: 0o700 });
  await fs.copyFile(REAL_PI_AUTH, dest);
  // `copyFile` happens to carry the source's 0600 over on macOS, which is the
  // only platform these run on — said explicitly anyway, because "the mode came
  // out right" is a property of the copy, not a promise the call makes.
  await fs.chmod(dest, 0o600);
  forgetOnExit(dirname(dest));
}

/**
 * Shred a staged credential when this process dies, however it dies.
 *
 * A smoke already removes its whole scratch in a `finally`, and that covers the
 * run that merely fails. It does not cover the run that is KILLED — and that is
 * the one that matters here, because what it leaves behind is a byte-identical
 * copy of a live bearer token sitting in `/var/folders` with nothing scheduled
 * to ever remove it. One was found there hours after the run that made it.
 *
 * Synchronous on purpose: `exit` cannot await, so a promise here would be
 * abandoned mid-unlink. `SIGKILL` is still unanswerable and always will be —
 * which is why the directory is 0700 above rather than trusting this alone.
 */
function forgetOnExit(dir) {
  const shred = () => rmSync(dir, { recursive: true, force: true });
  process.once("exit", shred);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      shred();
      process.exit(1);
    });
  }
}

// ---- model access ------------------------------------------------------------

/**
 * Seeds the app-wide default model that EVERY structured Session — Ticket or
 * Project — now requires before it can even start (`requireDefaultModel` in
 * `structured-sessions.ts`; `ticket-sessions.ts` and `project-sessions.ts`
 * both call it). There is no bootstrap for this anywhere in main: a fresh
 * profile's `app_state` simply has no row for it until something calls the
 * `modelAccess.setDefault` mutation, so every smoke that starts a Session has
 * to do this first — the same way Settings' "Default model" section does
 * (`model-access-settings.tsx`), just over the same tRPC edge directly rather
 * than through the Select+Save UI.
 *
 * Unpinned, this picks the first "available" model the LIVE catalog reports
 * (real Pi credentials must already be readable — see `ensurePiAuthInto`
 * callers) and that model's last-listed reasoning level, mirroring the Settings
 * pane's own `preferredReasoning` heuristic. That is the right default for a
 * probe whose subject is the Model Access plumbing itself: it survives upstream
 * retiring any particular model.
 *
 * It is the WRONG default for a probe that drives a real turn and then reports
 * how long one takes, because "first available at its highest reasoning level"
 * is a moving target — it silently became `openai-codex/gpt-5.3-codex-spark`
 * at `xhigh` while pi-ticket-chat-smoke's own header still claimed
 * `gpt-5.6-luna`, so the smoke had been misreporting what it tests. Those
 * probes pass `pin` and say so in their header. A pin is checked against the
 * live catalog and fails LOUDLY (with what IS available) rather than falling
 * back to the first-available pick, which would put the misreporting straight
 * back.
 *
 * @param {import("playwright-core").Page} page
 * @param {{providerId:string, modelId:string, reasoningLevel?:string}|null} [pin]
 * @returns {Promise<{providerId:string, modelId:string, reasoningLevel:string, label:string}>}
 */
export async function seedDefaultModel(page, pin = null) {
  const result = await page.evaluate(async (pinned) => {
    const inspected = await window.api.sessionRpc.request({
      procedure: "modelAccess.inspect",
      input: {},
    });
    if (!inspected.ok) return { ok: false, error: inspected };
    const models = inspected.data.models ?? [];
    const available = models
      .filter((candidate) => candidate.state === "available")
      .map((candidate) => `${candidate.providerId}/${candidate.modelId}`);
    const model = pinned
      ? models.find(
          (candidate) =>
            candidate.providerId === pinned.providerId && candidate.modelId === pinned.modelId,
        )
      : models.find((candidate) => candidate.state === "available");
    if (!model || (pinned && model.state !== "available")) {
      return {
        ok: false,
        error: {
          message: pinned
            ? `pinned model ${pinned.providerId}/${pinned.modelId} is ${model?.state ?? "absent from the live catalog"}`
            : "no available model in the live catalog",
          available,
        },
      };
    }
    const reasoningLevel = pinned?.reasoningLevel ?? model.reasoningLevels.at(-1) ?? "off";
    if (!model.reasoningLevels.includes(reasoningLevel)) {
      return {
        ok: false,
        error: {
          message: `${model.providerId}/${model.modelId} does not support reasoning level ${reasoningLevel}`,
          supported: model.reasoningLevels,
        },
      };
    }
    const selection = {
      providerId: model.providerId,
      modelId: model.modelId,
      reasoningLevel,
    };
    const saved = await window.api.sessionRpc.request({
      procedure: "modelAccess.setDefault",
      input: selection,
    });
    if (!saved.ok) return { ok: false, error: saved };
    return { ok: true, selection: { ...selection, label: model.label } };
  }, pin);
  if (!result.ok) {
    throw new Error(`seedDefaultModel failed: ${JSON.stringify(result.error)}`);
  }
  return result.selection;
}

// ---- one real chat turn ----------------------------------------------------

/**
 * How long ONE real Pi turn gets, measured from the keystroke that submits the
 * prompt to the moment the turn settles.
 *
 * This number is the whole reason a green build used to fail as a coin flip, so
 * it is written down rather than guessed. Timed submit → settle on one
 * one-sentence prompt against the UNPINNED default pick — first available at
 * its highest reasoning level, `openai-codex/gpt-5.3-codex-spark` at `xhigh`,
 * which is still what the smokes that pass no pin get — thirteen samples off a
 * fifteen-run series:
 *
 *   3.5s · 11.0s · 25.4s · 35.2s · 41.1s · 41.4s · 46.7s
 *   57.5s · 58.5s · 62.2s · 64.0s · 64.5s · 107.0s
 *
 * The ceiling it replaces was 30s, which sits MID-DISTRIBUTION — about half of
 * those runs exceed it. A ceiling near the median does not test anything; it
 * samples a distribution. 180s is past the longest observed turn with room for
 * a machine under load, and a turn that reaches it is a real hang worth reading
 * rather than a slow answer. Do not tidy it back down toward the measurements:
 * the measurements are exactly where a ceiling must not sit. A pinned model at
 * a low reasoning level answers far quicker than any of this (2-6s across five
 * runs of pi-ticket-chat-smoke on `gpt-5.6-luna`/`low`), and that is headroom,
 * not evidence for a smaller number — one budget covers every Pi smoke here,
 * pinned or not.
 */
export const PI_TURN_BUDGET_MS = 180_000;

/** The Stop control, on screen for exactly as long as a turn is running. */
export function stopButton(page) {
  return page.getByRole("button", { name: "Stop turn", exact: true });
}

/**
 * The assistant's PROSE replies — what a person would call the answer — one
 * entry per assistant turn that produced text, empty ones dropped.
 *
 * `.is-assistant` alone cannot answer this, and quietly said "yes" far too
 * early. `Message` (`ui/ai-elements/message.tsx`) stamps that class on the WHOLE
 * assistant turn, and `chat-plane.tsx`'s `renderSegment` draws the tool
 * ActivityBundle inside it — so the first `.is-assistant` text of a turn that
 * runs anything at all is the bundle's own summary, literally "Ran 1 command".
 * A wait gated on that starts its clock when the model reaches for a tool, not
 * when it answers.
 *
 * The partition is the transcript's own: every non-prose row carries
 * `not-prose` (`activity-ui.tsx`'s bundle roots, tool rows and status lines;
 * `interaction-ui.tsx`'s status line), and a pending question is an
 * InteractionCard `<form>` — a question, never a reply. Strip both from a clone
 * and what is left inside an assistant turn can only have come from a `text`
 * segment, which is the only thing `renderSegment` renders as prose.
 */
export async function assistantReplyTexts(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".is-assistant"))
      .map((message) => {
        const prose = message.cloneNode(true);
        for (const activity of prose.querySelectorAll(".not-prose, form")) activity.remove();
        return prose.textContent?.trim() ?? "";
      })
      .filter((text) => text.length > 0),
  );
}

/**
 * Wait out one real turn: Stop gone AND a non-empty assistant prose reply on
 * screen, both inside ONE budget measured from `since` — the moment the prompt
 * was submitted.
 *
 * One clock, one deadline, on purpose. The two-wait version this replaces gave
 * the settle its own fresh 30s starting from whenever the first `.is-assistant`
 * node appeared, which made the real budget "30s for the remainder of the turn
 * after the first tool call" — a sentence nobody wrote down and nobody could
 * have measured against.
 *
 * @param {import("playwright-core").Page} page
 * @param {{since:number, budget?:number}} opts
 * @returns {Promise<{texts:string[], elapsedMs:number}>}
 */
export async function waitForSettledReply(page, { since, budget = PI_TURN_BUDGET_MS }) {
  const texts = await waitUntil(
    "the turn to settle with a non-empty assistant text reply",
    async () => {
      const [running, replies] = await Promise.all([
        stopButton(page).count(),
        assistantReplyTexts(page),
      ]);
      return running === 0 && replies.length > 0 ? replies : false;
    },
    { timeout: Math.max(1000, budget - (Date.now() - since)), interval: 250 },
  ).catch(async (error) => {
    // Which half was missing is the whole diagnosis: still streaming is a slow
    // turn, settled-with-no-prose is a turn that answered in tool calls only.
    const [running, replies, turns] = await Promise.all([
      stopButton(page).count(),
      assistantReplyTexts(page),
      page.evaluate(() => document.querySelectorAll(".is-assistant").length),
    ]);
    throw new Error(
      `${error.message} — after ${Date.now() - since}ms: stopVisible=${running > 0} ` +
        `proseReplies=${replies.length} assistantTurns=${turns}`,
    );
  });
  return { texts, elapsedMs: Date.now() - since };
}

// ---- Monaco DOM readers ----------------------------------------------------

/**
 * The mounted Monaco editor host. `[data-monaco-status]` is set imperatively by
 * `components/editor/monaco-{file,document}-editor.tsx`; `.monaco-editor` is
 * Monaco's own root inside it. Nothing in the app renders one without the other,
 * so this pair is the ONE selector every smoke uses to reach an editor.
 */
export const MONACO_EDITOR_SELECTOR = "[data-monaco-status] .monaco-editor";

/**
 * The Monaco editor inside `scope` (a Page or a Locator — a dialog, a tab panel).
 * Scoped rather than page-global because several surfaces mount more than one
 * editor at a time (ticket detail's body + a file tab).
 *
 * @param {import("playwright-core").Page | import("playwright-core").Locator} scope
 */
export function monacoEditor(scope) {
  return scope.locator(MONACO_EDITOR_SELECTOR).first();
}

/**
 * Put the caret in `scope`'s Monaco editor, ready for `page.keyboard.type()`.
 * Monaco's input surface in this build is a `native-edit-context` div rather
 * than a textarea (see {@link readMonacoState}), so there is nothing to `fill()`
 * and nothing to `focus()` by role — typing is always click-then-keyboard.
 *
 * Polls `data-monaco-status === "ready"` first: the host can mount with a
 * `.monaco-editor` child a tick before the model is actually receptive, and a
 * click+type in that window drops the leading keystrokes.
 *
 * @param {import("playwright-core").Page | import("playwright-core").Locator} scope
 */
export async function clickMonaco(scope) {
  const editor = monacoEditor(scope);
  await waitUntil("Monaco editor to be ready", async () => {
    try {
      const status = await editor.evaluate(
        (el) => el.closest("[data-monaco-status]")?.getAttribute("data-monaco-status") ?? null,
      );
      return status === "ready" ? status : null;
    } catch {
      return null;
    }
  });
  await editor.click();
}

/** The Page behind a Page-or-Locator scope. */
function pageOf(scope) {
  return typeof scope.page === "function" ? scope.page() : scope;
}

/**
 * Click into `scope`'s Monaco editor, type `text`, and WAIT for the document to
 * actually hold it.
 *
 * The waits are not decoration. {@link clickMonaco} first polls
 * `data-monaco-status === "ready"`, then Monaco's `native-edit-context` applies
 * keystrokes on asynchronous `textupdate` events — so with Playwright's
 * zero-delay typing the last characters are still in flight when the next
 * action runs. A probe that typed a body and immediately pressed the kickoff
 * hotkey created its ticket with the final three characters missing. Polling
 * the rendered document is both the fix and a stronger assertion than the bare
 * type it replaces.
 *
 * @param {import("playwright-core").Page | import("playwright-core").Locator} scope
 * @param {string} text
 */
export async function typeIntoMonaco(scope, text) {
  const page = pageOf(scope);
  await clickMonaco(scope);
  await page.keyboard.type(text);
  // `readMonacoText` joins rendered view-lines with `\n` and does not invent a
  // trailing newline for the final line, so a typed string that ends in `\n`
  // (file contents, etc.) must be matched without that terminator.
  const expected = text.replaceAll("\r\n", "\n").replace(/\n$/, "");
  await waitUntil(`typed text to land in Monaco (${JSON.stringify(text.slice(-24))})`, async () => {
    const actual = await readMonacoText(scope);
    return actual.includes(expected) ? actual : null;
  });
}

/**
 * The rendered text of `scope`'s Monaco editor, newline-joined per view line and
 * with Monaco's non-breaking spaces normalized back to spaces — the scoped twin
 * of {@link readMonacoState}'s `lines`.
 *
 * NOTE: this is `textContent`, so it INCLUDES text Document Mode has collapsed
 * with `display:none` (`volli-md-hidden`). That makes it the right reader for
 * "does the buffer contain X" and the WRONG one for "is X visible" — for the
 * latter use {@link readDocumentLine}, which consults computed style.
 *
 * @param {import("playwright-core").Page | import("playwright-core").Locator} scope
 */
export async function readMonacoText(scope) {
  return monacoEditor(scope).evaluate((editor) =>
    Array.from(editor.querySelectorAll(".view-line"))
      .map((line) => (line.textContent ?? "").replace(/\u00a0/g, " "))
      .join("\n"),
  );
}

/**
 * Split ONE rendered Document Mode line into what a human SEES and what is
 * COLLAPSED, plus the `volli-md-*` classes it carries. Returns null when no
 * rendered line contains `needle` (a virtualized line Monaco has not drawn yet).
 *
 * This partition is the only honest reading of "is this delimiter visible?".
 * Monaco has no `Decoration.replace`, so Document Mode collapses markdown
 * punctuation with an `inlineClassName` whose CSS is `display:none`: the
 * characters stay in the DOM and `textContent` still returns them, which means
 * `!line.includes("## ")` FAILS even when the reveal rule is working perfectly.
 * Reading computed style is also strictly STRONGER than the CodeMirror-era text
 * assertions it replaces — it proves the mark is present AND invisible, where a
 * projection that never ran at all used to pass.
 *
 * Monaco renders a view line as leaf spans, one per decoration range, so a
 * collapsed delimiter is always its own span.
 *
 * The partition below is written out longhand inside the `evaluate` callback
 * rather than factored into helpers: the body is serialized into the renderer,
 * so nothing here can reference anything defined outside it.
 *
 * @param {import("playwright-core").Page} page
 * @param {string} needle
 * @returns {Promise<{text:string, visible:string, collapsed:string, classes:string[]}|null>}
 */
export function readDocumentLine(page, needle) {
  return page.evaluate((search) => {
    const nbsp = /\u00a0/g;
    const line = Array.from(document.querySelectorAll(".view-line")).find((el) =>
      (el.textContent ?? "").replace(nbsp, " ").includes(search),
    );
    if (!line) return null;
    const visible = [];
    const collapsed = [];
    for (const span of line.querySelectorAll("span")) {
      if (span.children.length > 0) continue; // only leaf spans hold text
      const bucket =
        getComputedStyle(span).display === "none" || span.getBoundingClientRect().width === 0
          ? collapsed
          : visible;
      bucket.push((span.textContent ?? "").replace(nbsp, " "));
    }
    const classes = new Set();
    for (const el of line.querySelectorAll("[class]")) {
      for (const name of el.classList) if (name.startsWith("volli-md-")) classes.add(name);
    }
    return {
      text: (line.textContent ?? "").replace(nbsp, " "),
      visible: visible.join(""),
      collapsed: collapsed.join(""),
      classes: [...classes].toSorted(),
    };
  }, needle);
}

/**
 * The same seen/collapsed partition across EVERY rendered line at once — what
 * "no delimiter is visible ANYWHERE" needs, since that is a statement about the
 * whole view rather than one line. See {@link readDocumentLine} for why computed
 * style is the only valid signal.
 *
 * @param {import("playwright-core").Page} page
 * @returns {Promise<{visible:string, collapsed:string}>}
 */
export function readDocumentView(page) {
  return page.evaluate(() => {
    const nbsp = /\u00a0/g;
    const visible = [];
    const collapsed = [];
    for (const span of document.querySelectorAll(".view-line span")) {
      if (span.children.length > 0) continue; // only leaf spans hold text
      const bucket =
        getComputedStyle(span).display === "none" || span.getBoundingClientRect().width === 0
          ? collapsed
          : visible;
      bucket.push((span.textContent ?? "").replace(nbsp, " "));
    }
    return { visible: visible.join(""), collapsed: collapsed.join("") };
  });
}

/**
 * Read the mounted Monaco editor(s) straight out of the page. THE one place the
 * smokes encode how to interrogate this Monaco build — both the Files workbench
 * probe and the global-artifacts probe go through it, so an input-strategy
 * change is a one-file fix instead of two copies with one silently stale.
 *
 * The `[data-monaco-status]` host attributes are OUR contract (what the app
 * configured); `editorAriaLabel` is Monaco's own RENDERED accessible name (what
 * the user actually gets). Editability assertions must consult both — see
 * {@link isMonacoEditable}.
 *
 * Reads the FIRST host; `hostCount` is what a lazy-mount probe asserts on.
 *
 * @param {import("playwright-core").Page} page
 */
export async function readMonacoState(page) {
  return page.evaluate(() => {
    const hosts = Array.from(document.querySelectorAll("[data-monaco-status]"));
    const host = hosts[0] ?? null;
    const editor = host?.querySelector(".monaco-editor") ?? null;
    // Monaco's input surface in this build is a `native-edit-context` div: the
    // only <textarea> under .monaco-editor is the permanently-readonly IME
    // helper, so ITS `readonly` attribute says nothing about the document (a
    // `textarea[readonly]` assertion here silently tests nothing).
    // `textarea.inputarea` covers the older input strategy.
    const input = editor?.querySelector(".native-edit-context, textarea.inputarea") ?? null;
    const fallbacks = Array.from(document.querySelectorAll("[data-monaco-fallback]"));
    return {
      hostCount: hosts.length,
      // The degraded `<pre data-monaco-fallback="true">` means the real editor
      // never booted — a hard failure signal anywhere it appears.
      fallbacks: fallbacks.length,
      fallbackTitle: fallbacks[0]?.getAttribute("title") ?? null,
      status: host?.getAttribute("data-monaco-status") ?? null,
      language: host?.getAttribute("data-monaco-language") ?? null,
      worker: host?.getAttribute("data-monaco-worker") ?? null,
      readOnly: host?.getAttribute("data-monaco-read-only") ?? null,
      dirty: host?.getAttribute("data-monaco-dirty") ?? null,
      saving: host?.getAttribute("data-monaco-saving") ?? null,
      stale: host?.getAttribute("data-monaco-stale") ?? null,
      hasEditor: editor !== null,
      editorAriaLabel: input?.getAttribute("aria-label") ?? null,
      text: editor?.textContent ?? "",
      // Monaco renders spaces as non-breaking spaces, so rendered line text
      // never string-matches source bytes until they are normalized back.
      lines: Array.from(editor?.querySelectorAll(".view-line") ?? [])
        .map((line) => (line.textContent ?? "").replace(/\u00a0/g, " "))
        .join("\n"),
    };
  });
}

/**
 * Is the read editor genuinely editable (CONCEPT #49's explicit-save document)?
 *
 * Two independent signals, because either alone can lie: our own
 * `data-monaco-read-only` contract attribute must say "false", AND Monaco's
 * rendered accessible name must not carry the ", read-only" suffix that
 * `fileEditorAriaLabel` appends only for a read-only view. A `null` label means
 * no input surface was found at all, which is a failure, not a pass.
 *
 * @param {Awaited<ReturnType<typeof readMonacoState>>} state
 */
export function isMonacoEditable(state) {
  return (
    state.readOnly === "false" &&
    state.editorAriaLabel !== null &&
    !state.editorAriaLabel.endsWith(", read-only")
  );
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

/**
 * Return to a stable board view. Kickoff can write its harness probe before a
 * pending detail transition finishes, so a fixed post-click delay can observe
 * the board briefly and then lose it again. Require the board header to remain
 * visible across a settle window and retry the nav click if a late transition
 * wins the first race.
 */
export async function goToBoard(page) {
  const boardReady = page.getByRole("button", { name: "New ticket", exact: true });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (!(await boardReady.isVisible().catch(() => false))) {
      const boardNav = page.getByRole("button", { name: "Board", exact: true });
      if (await boardNav.count()) await boardNav.first().click();
    }

    const visible = await waitUntil(`board view attempt ${attempt}`, () => boardReady.isVisible(), {
      timeout: 5000,
    })
      .then(() => true)
      .catch(() => false);
    if (!visible) continue;

    await sleep(500);
    if (await boardReady.isVisible().catch(() => false)) return;
  }

  throw new Error("board view did not become stable");
}

/**
 * Start a terminal Session from a surface's session-start control.
 *
 * The ONE encoding of that gesture. The control is a split button: its press
 * starts a CHAT (so a probe that wants a chat just clicks `New chat`), and a
 * terminal lives behind the caret half. The menu item's accessible name is
 * computed from its whole subtree, so on the Sessions strip — the one mount
 * that announces the chords — it reads "Terminal ⌥⌘T"; matching a prefix is
 * what works on every mount.
 *
 * `scope` is a Locator (a rail, a strip's container) or the Page itself.
 */
export async function startTerminalSession(scope) {
  await scope.getByRole("button", { name: "Other session kinds", exact: true }).first().click();
  const page = scope.page?.() ?? scope;
  await page.getByRole("menuitem", { name: /^Terminal/ }).click();
}

// ---- tab strips ------------------------------------------------------------

/** The accessible name each tab strip announces (`ticket-tabs.tsx`, `session-tabs.tsx`). */
export const TICKET_TAB_STRIP = "Ticket tabs";
export const SESSION_TAB_STRIP = "Session tabs";

/**
 * One named tab strip's tablist.
 *
 * Naming it is not decoration. A ticket screen draws TWO tablists — this strip
 * and the details rail's page switcher — so an unnamed `[role="tablist"]` is
 * ambiguous, and every unscoped `[role="tab"]` question on that screen counts
 * the rail's pages as if they were tabs you could open a chat into.
 */
export function tabStrip(page, name) {
  return page.getByRole("tablist", { name, exact: true });
}

/**
 * A named tab strip's own session-start control — the press half, which starts
 * a chat.
 *
 * Scoped by walking UP from the tablist to the nearest ancestor that also holds
 * such a control, rather than by hopping a fixed number of parents. The strip is
 * one row carrying both populations — tabs on the left, the things that act on
 * them past a divider on the right — but how many wrappers sit between them is a
 * layout decision, and it has already moved once: the ticket strip's control
 * left the tabs' overflow scroller to sit past a divider, which stranded a `..`
 * hop inside that scroller with nothing to click.
 *
 * The walk still has teeth, which a page-wide `getByRole` would not: a ticket
 * screen carries a SECOND copy of this control in the rail's Sessions panel, so
 * an unscoped query either matches two or quietly presses the wrong one, and a
 * probe that means "the strip's control created this tab" would go on passing
 * with the strip's control gone.
 */
export function tabStripNewChatButton(page, name) {
  return tabStrip(page, name)
    .locator('xpath=ancestor::*[.//button[@aria-label="New chat"]][1]')
    .getByRole("button", { name: "New chat", exact: true });
}

/** The `aria-label` of the tab currently front in one named strip, or null. */
export async function activeTabLabel(page, name) {
  return tabStrip(page, name)
    .locator('[role="tab"][aria-selected="true"]')
    .getAttribute("aria-label");
}

/**
 * Press a named strip's session-start control and wait for the chat tab it
 * mints, returning that tab's label.
 *
 * Counted inside the strip, so the rail's pages cannot make the delta look
 * satisfied — or, on the ticket screen, satisfied before the click even lands.
 */
export async function openNewChatTab(page, name) {
  const strip = tabStrip(page, name);
  const tabs = strip.getByRole("tab");
  const tabsBefore = await tabs.count();
  await tabStripNewChatButton(page, name).click();
  await waitUntil("a new chat tab to appear", async () => (await tabs.count()) > tabsBefore);
  const label = await activeTabLabel(page, name);
  if (label === null) throw new Error("no tab became active after New chat");
  return label;
}
