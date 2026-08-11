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
 *                      with extra env merged over process.env. Skips the PTY-busy
 *                      close confirm.
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
 *   • seedDefaultModel() — records the app-wide default model every structured
 *                      Session (Ticket or Project) now requires before it can
 *                      start, over the same `modelAccess.setDefault` tRPC
 *                      mutation Settings uses. Needs real Pi credentials
 *                      already readable, so callers run it after seeding those.
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
 * @param {{dbPath:string, userDataDir:string, extraEnv?:Record<string,string>}} opts
 */
export function launch({ dbPath, userDataDir, extraEnv = {} }) {
  const worktreeHome = worktreeHomeFor(dbPath, extraEnv);
  // Cursor / some agent shells set ELECTRON_RUN_AS_NODE=1, which makes the
  // Electron binary run as plain Node and immediately crash on protocol APIs.
  // Match scripts/start-electron.mjs and strip it for every smoke launch.
  const env = {
    ...process.env,
    VOLLI_DB_PATH: dbPath,
    VOLLI_SKIP_CLOSE_CONFIRM: "1",
    ...extraEnv,
    VOLLI_WORKTREE_HOME_DIR: worktreeHome,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return _electron.launch({
    executablePath: ELECTRON,
    args: [APP_DIR, `--user-data-dir=${userDataDir}`],
    env,
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
 * Picks the first "available" model the LIVE catalog reports (real Pi
 * credentials must already be readable — see `ensurePiAuthInto` callers) and
 * that model's last-listed reasoning level, mirroring the Settings pane's own
 * `preferredReasoning` heuristic, rather than hardcoding a provider/model/
 * reasoning triple upstream's own catalog is free to stop supporting.
 *
 * @param {import("playwright-core").Page} page
 * @returns {Promise<{providerId:string, modelId:string, reasoningLevel:string, label:string}>}
 */
export async function seedDefaultModel(page) {
  const result = await page.evaluate(async () => {
    const inspected = await window.api.sessionRpc.request({
      procedure: "modelAccess.inspect",
      input: {},
    });
    if (!inspected.ok) return { ok: false, error: inspected };
    const models = inspected.data.models ?? [];
    const model = models.find((candidate) => candidate.state === "available");
    if (!model) return { ok: false, error: { message: "no available model in the live catalog" } };
    const reasoningLevel = model.reasoningLevels.at(-1) ?? "off";
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
  });
  if (!result.ok) {
    throw new Error(`seedDefaultModel failed: ${JSON.stringify(result.error)}`);
  }
  return result.selection;
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
