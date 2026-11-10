/**
 * End-to-end acceptance smoke for HOME'S MAIN-CHECKOUT FILE WORKSPACE
 * (VC-121/VC-122; decisions #49/#54/#55/#56). Drives the REAL packaged
 * renderer through Playwright against a scratch SQLite database
 * (`VOLLI_DB_PATH`) + an isolated user-data dir, over a REAL git repository
 * seeded on disk.
 *
 * Files was retired as a first-class nav item (VC-122): this smoke used to
 * open a file from a standalone Files page and its always-visible sidebar
 * tree. Both are gone. The surface now is the Home rail's Files navigator (a
 * single-level folder browser you walk into and out of, not an
 * always-expanded tree) and Home's own tab strip — File tabs sit beside
 * Board/Session tabs in ONE strip rather than a dedicated one. The rail (and
 * the Files page inside it) is only ever visible beside a Session or File
 * tab, never over the Board, so every check that needs it starts a terminal
 * Session first if nothing is in front yet.
 *
 *   1. Home's rail Files navigator lists the seeded repo at its root, and a
 *      row exposes Open in… plus Finder — before anything is open.
 *   2. Single click opens ONE preview Home File tab — italic/replaceable
 *      (`data-preview="true"`), with a real Monaco editor reaching
 *      `data-monaco-status="ready"` and NO `data-monaco-fallback` anywhere.
 *   3. Single-clicking a second file in the same folder REPLACES the preview
 *      tab in place — the strip still holds exactly one File tab.
 *   4. Double click PINS — the tab turns persistent (`data-preview="false"`),
 *      a later single click opens a SECOND tab beside it instead of
 *      replacing it, and two open tabs sharing a basename (one from `src/`,
 *      one from `lib/`) get disambiguating hints.
 *   5. Editing marks the tab dirty AND pins it — typing into Monaco flips the
 *      tab to `data-dirty="true"` and promotes the preview slot to
 *      persistent (decision #56: a dirty tab is never replaced).
 *   6. ⌘S saves, and DISK BYTES match — the tab goes clean and the file read
 *      back with `fs` really contains the typed text.
 *   7. A FULL RELAUNCH restores the workspace — closing the app and reopening
 *      the same profile restores the same Home File tabs, in the same order,
 *      with the same pinned/preview flags and the same active tab. This is a
 *      strictly stronger proof than the old nav-switch-remount version ever
 *      was: Home is now always mounted, so a relaunch is the only real
 *      "gone and back" boundary left for this surface.
 *   8. Restoration is LAZY — on relaunch, exactly ONE Monaco host is mounted
 *      (the active tab's). Inactive tabs restore identity only, never
 *      contents.
 *   9. Dirty close is GUARDED — closing a dirty tab (the relaunched, restored
 *      preview tab) raises the save guard; Cancel keeps it open and still
 *      dirty; Save closes it and the new bytes are on disk.
 *  10. Directory refresh is LIVE — a file created on disk inside the
 *      navigator's current folder appears with no manual refresh.
 *
 *  QO1–QO8. Real ⌘P Main/worktree indexing, fuzzy ranking, preview/pin and
 *      destination activation, in a separate project AFTER the two-boot proof.
 *
 * Every assertion polls (expect-style waits); no bare sleep stands in for a
 * condition (the few fixed sleeps only pace UI settling, never assert).
 *
 * This smoke needs a display + the built app. It runs in the extended desktop
 * smoke tier, not in `vp test`, and can also run locally on macOS.
 *
 *   Run (macOS ONLY — see below):
 *     vp run --filter @volli/desktop build   # produce dist/ + dist-electron/
 *     node apps/desktop/e2e/project-files-smoke.mjs
 *
 *   Requires: playwright-core (devDependency of @volli/desktop), and macOS.
 *   Checks 5, 6 and 9 drive the ⌘↑ (cursorTop) and ⌘S (save) chords, which are
 *   macOS keybindings — on Linux/Windows they resolve to nothing, so the edit
 *   never lands and those checks would sit out their poll timeout instead of
 *   reporting anything useful. (smoke-kit's ELECTRON path is a macOS
 *   `Electron.app` bundle too, so every smoke here is macOS-bound anyway.) The
 *   platform guard below turns that into an immediate, explanatory failure.
 *
 *   Exit code is non-zero if any numbered check fails.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { createTicketViaBridge } from "./lib/agent-kit.mjs";
import {
  assertProfileIsolated,
  createRunner,
  isMonacoEditable,
  launch,
  makeGitRepo,
  makeScratch,
  readMonacoState,
  seedProjects,
  sleep,
  startTerminalSession,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const execFileAsync = promisify(execFile);

// Fail fast rather than half-run: checks 5, 6 and 9 type through ⌘↑ / ⌘S, which
// only mean cursorTop/save on macOS. Bail before any scratch dir is allocated.
if (process.platform !== "darwin") {
  console.error(
    `project-files-smoke is macOS-only (got platform "${process.platform}"): checks 5, 6 and 9 drive ` +
      "the ⌘↑ (cursorTop) and ⌘S (save) keybindings, which do not exist on this platform.",
  );
  process.exit(1);
}

const { userDataDir, dbPath, scratch, cleanup } = await makeScratch("volli-project-files-smoke-");

const PROJECT_SEED_ID = "project-files-project";
const PROJECT_NAME = "Project Files Project";
const TICKET_PREFIX = "PF";

// ---- the seeded repository -------------------------------------------------
// `lib/app.ts` deliberately shares its basename with `src/app.ts`: opening both
// is what makes the tab strip render disambiguating hints (check 4). Row
// identity in the navigator is always the full project-relative path, even
// while standing inside the folder that contains it — these constants double
// as both the seeded relative paths and the `data-path`/`data-rel-path` values
// the DOM carries throughout.
const APP_TS = "src/app.ts";
const UTIL_TS = "src/util.ts";
const LIB_APP_TS = "lib/app.ts";
const README = "README.md";
/** Created on disk mid-run, inside the navigator's open folder (check 10). */
const APPEARED_TS = "src/appeared.ts";

const APP_TS_CONTENT = 'export const app = "src app";\n';
const UTIL_TS_CONTENT = 'export const util = "src util";\n';
const LIB_APP_TS_CONTENT = 'export const app = "lib app";\n';

// Markers are typed through the real keyboard, so they hold no characters
// Monaco would auto-close or auto-indent (quotes, brackets, list bullets).
const EDIT_MARKER = "// PF-EDIT-MARKER-1";
const GUARD_MARKER = "PF-GUARD-MARKER-2";

// ---- DOM helpers -----------------------------------------------------------

function homeFilesPanel(page) {
  return page.getByTestId("home-files-panel");
}

/** One row in the Home Files tree — `relPath` is always the full
 * project-relative path (`files/file-tree.tsx`). */
function fileRow(page, relPath) {
  return homeFilesPanel(page).locator(`[data-testid="ticket-files-row"][data-path="${relPath}"]`);
}

function homeFileTab(page, relPath) {
  return page.locator(`[data-testid="home-file-tab"][data-rel-path="${relPath}"]`);
}

function closeButtonFor(page, relPath) {
  return page.locator(
    `[data-testid="home-file-tab"][data-rel-path="${relPath}"] [data-testid="tab-close"]`,
  );
}

function saveGuard(page) {
  return page.locator('[data-testid="file-save-guard"]');
}

/**
 * Ensure the Home inspector is showing its Files navigator, starting a terminal
 * Session first if the Board is in front. The inspector subtree is resident
 * even while disabled on the Board; its corner control exists only beside
 * a Session or File tab (`home-surface.tsx`'s `railVisible`).
 */
async function openHomeFilesRail(page) {
  const detailsToggle = page.getByRole("button", { name: /^(Show|Hide) details rail$/ });
  if ((await detailsToggle.count()) === 0) {
    await startTerminalSession(page);
    await detailsToggle.waitFor({ state: "visible", timeout: 20000 });
  }
  // The inspector is resident even when collapsed. Pin it before using its
  // controls rather than treating a mounted rail as a visible one.
  const showDetails = page.getByRole("button", { name: "Show details rail", exact: true });
  if (await showDetails.isVisible()) await showDetails.click();
  await page.getByTestId("home-rail-tab-files").click();
  await waitUntil("Home Files panel", async () => (await homeFilesPanel(page).count()) === 1);
}

/** Open root-level directory `dirRelPath` in the navigator's tree and wait for
 * `expectChild`'s row (a full relPath) to appear inside it. A click on an open
 * folder folds it, so an already-open folder is left as it is. */
async function navigateIntoDir(page, dirRelPath, expectChild) {
  await waitUntil(
    `${dirRelPath}/ row`,
    async () => (await fileRow(page, dirRelPath).count()) === 1,
  );
  if ((await fileRow(page, dirRelPath).getAttribute("aria-expanded")) !== "true") {
    await fileRow(page, dirRelPath).click();
  }
  await waitUntil(
    `navigator inside ${dirRelPath}/`,
    async () => (await fileRow(page, expectChild).count()) === 1,
  );
}

/** Walk the navigator back out to the project root. */
async function navigateToRoot(page) {
  const up = homeFilesPanel(page).getByTestId("file-tree-up");
  for (let guard = 0; guard < 10 && (await up.count()) === 1; guard += 1) {
    await up.click();
    await sleep(50);
  }
  await waitUntil("navigator back at root", async () => (await up.count()) === 0);
}

/**
 * The whole strip's File tabs, left to right — order, identity and per-tab
 * state in one read. Scoped to File tabs only: Board and Session tabs sit
 * beside them in the same strip and carry none of these attributes, so they
 * cannot smuggle themselves into a length/order assertion below.
 */
async function readTabs(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="home-file-tab"]')).map((tab) => ({
      relPath: tab.getAttribute("data-rel-path"),
      preview: tab.getAttribute("data-preview"),
      dirty: tab.getAttribute("data-dirty"),
      active: tab.getAttribute("aria-selected") === "true",
      name: tab.getAttribute("aria-label"),
    })),
  );
}

/** A compact, loggable signature of the File-tab strip (what check 7 compares
 * across a relaunch). */
function tabSignature(tabs) {
  return tabs.map((t) => `${t.relPath}[${t.preview === "true" ? "preview" : "pinned"}]`).join(" ");
}

/**
 * Every mounted Monaco host plus the fallback signal — the shared
 * {@link readMonacoState} reader in smoke-kit, which is where this build's
 * Monaco interrogation (input surface, read-only contract, rendered
 * aria-label) is encoded ONCE for every probe that opens an editor.
 * `hostCount` is the lazy-restoration probe (check 8) and `fallbacks` is a hard
 * failure signal anywhere it appears — the degraded
 * `<pre data-monaco-fallback="true">` means the real editor never booted.
 */
const readMonaco = readMonacoState;

/**
 * Wait for the active tab's editor to boot into a usable Monaco. `needle`, when
 * given, additionally waits for that text to be RENDERED — `data-monaco-status`
 * flips to "ready" the moment the editor is created, a tick before its first
 * paint, so asserting on line text without this races the renderer.
 */
async function waitForMonacoReady(page, label, needle = null) {
  return waitUntil(
    `Monaco ready (${label})${needle === null ? "" : ` showing ${JSON.stringify(needle)}`}`,
    async () => {
      const state = await readMonaco(page);
      const rendered = needle === null || state.lines.includes(needle);
      if (state.status === "ready" && state.hasEditor && state.fallbacks === 0 && rendered) {
        return state;
      }
      throw new Error(`state=${JSON.stringify({ ...state, lines: state.lines.slice(0, 200) })}`);
    },
    { timeout: 30000 },
  );
}

/** Put the caret in the editor via a real click, and prove focus actually landed there. */
async function focusMonaco(page) {
  const lines = page.locator("[data-monaco-status] .monaco-editor .view-lines");
  await waitUntil("Monaco view-lines", async () => (await lines.count()) >= 1);
  await lines.first().click();
  await waitUntil("keyboard focus inside Monaco", () =>
    page.evaluate(() => {
      const active = document.activeElement;
      return active instanceof HTMLElement && active.closest(".monaco-editor") !== null;
    }),
  );
}

/** Type `marker` as a new first line of the focused editor (deterministic caret). */
async function typeMarkerAtTop(page, marker) {
  await focusMonaco(page);
  await page.keyboard.press("Meta+ArrowUp"); // cursorTop
  await page.keyboard.type(marker);
  await page.keyboard.press("Enter");
}

/** Failure sink for anything Monaco-shaped hitting the console — the same sink
 * is reused across both windows this smoke opens (before and after check 7's
 * relaunch), so a regression on either side of it is reported once at the end. */
function watchForMonacoFailures(page, sink) {
  page.on("console", (message) => {
    if (
      (message.type() === "warning" || message.type() === "error") &&
      /monaco|worker|fallback/i.test(message.text())
    ) {
      sink.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    if (/monaco|worker|fallback/i.test(error.message)) {
      sink.push(`pageerror: ${error.message}`);
    }
  });
}

// ---- M8: real quick-open checks, isolated from the restart checkpoint --------

const PROJECT = { id: "quick-open-project", name: "Quick Open Project", prefix: "QO" };

// ---- the seeded repository -------------------------------------------------
// Everything committed here exists in BOTH checkouts once the worktree is cut,
// so none of it could tell the two scopes apart. The two files that can are
// written after the cut: MAIN_ONLY into the main checkout and WORKTREE_ONLY
// into the worktree (both untracked — `git ls-files --others` lists them).
const ALPHA_TS = "src/alpha-widget.ts";
const BETA_TS = "src/beta-widget.ts";
const GAMMA_MD = "docs/gamma-notes.md";
const MAIN_FILE = "main-checkout-file.ts";
// The audit's worked example (VC-299 / A13), verbatim. The artifact is NOT a
// basename match for `README` — its path is, scattered across
// a-r-t-i-f-a-c-t-s / d-e-s-i-g-n / a-u-d-i-t — which is exactly the shape the
// +1000 artifact bonus used to promote over an exact name.
const ROOT_README = "README.md";
const AUDIT_ARTIFACT = ".volli/artifacts/design-audit/audit-motion-perf.md";
const MAIN_ONLY = "main-untracked-only.ts";
const WORKTREE_ONLY = "worktree-only-file.ts";
const WORKTREE_SECOND = "second-worktree-file.ts";

const git = (cwd, args) => execFileAsync("git", args, { cwd });

// ---- DOM helpers -----------------------------------------------------------

const quickOpenList = (page) => page.getByTestId("quick-open-list");

/** Every offered row's text, top-ranked first (label + its folder). */
async function quickOpenRows(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="quick-open-list"] [cmdk-item]')).map(
      (row) => (row.textContent ?? "").trim(),
    ),
  );
}

/**
 * Press ⌘P, wait for the overlay AND for its rows — the index is fetched fresh
 * per open (an IPC round trip), so an overlay that is on screen is not yet an
 * overlay with anything in it. Types `query` before waiting when given.
 */
async function openQuickOpen(page, query = "") {
  await page.keyboard.press("Meta+p");
  await waitUntil("quick-open overlay", async () => (await quickOpenList(page).count()) === 1);
  if (query !== "") {
    await page.keyboard.type(query);
    await sleep(150);
  }
  await waitUntil("quick-open rows", async () => (await quickOpenRows(page)).length > 0, {
    timeout: 15000,
  });
}

async function closeQuickOpen(page) {
  if ((await quickOpenList(page).count()) === 1) {
    await page.keyboard.press("Escape");
    await waitUntil("quick-open closed", async () => (await quickOpenList(page).count()) === 0);
  }
}

/** Home's File tabs, left to right — identity, preview state, selection. */
async function readQuickOpenHomeTabs(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="home-file-tab"]')).map((tab) => ({
      relPath: tab.getAttribute("data-rel-path"),
      preview: tab.getAttribute("data-preview"),
      active: tab.getAttribute("aria-selected") === "true",
    })),
  );
}

/**
 * Ticket File tabs keep basename accessible names. The witnesses here are
 * root-level paths, so exact names identify them without Home-strip captions.
 */
async function readTicketTabs(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="tablist"] [role="tab"]')).map((tab) => ({
      label: tab.getAttribute("aria-label") ?? "",
      preview: tab.getAttribute("data-preview"),
      active: tab.getAttribute("aria-selected") === "true",
    })),
  );
}

const ticketTab = (tabs, relPath) => tabs.find((tab) => tab.label === relPath);

async function makeQuickOpenRepo() {
  const projectPath = await makeGitRepo(scratch, "quick-open-");
  await fs.mkdir(join(projectPath, "src"), { recursive: true });
  await fs.mkdir(join(projectPath, "docs"), { recursive: true });
  await fs.writeFile(join(projectPath, ALPHA_TS), "export const a = 1;\n");
  await fs.writeFile(join(projectPath, BETA_TS), "export const b = 1;\n");
  await fs.writeFile(join(projectPath, GAMMA_MD), "# gamma\n");
  await fs.writeFile(join(projectPath, MAIN_FILE), "export const m = 1;\n");
  await fs.writeFile(join(projectPath, ROOT_README), "# Quick Open Project\n");
  await git(projectPath, ["add", "-A"]);
  await git(projectPath, ["commit", "-q", "-m", "seed files"]);
  // Force-included by `buildFileIndex` (never committed, `.volli` is ignored):
  // it reaches the index the same way a real design-audit artifact does.
  await fs.mkdir(join(projectPath, ".volli/artifacts/design-audit"), { recursive: true });
  await fs.writeFile(join(projectPath, AUDIT_ARTIFACT), "# audit: motion perf\n");

  return projectPath;
}

async function runQuickOpenChecks(page, projectPath, { attempt, must }) {
  // A different project, AFTER the original two-boot restore/lazy/guard proof.
  // None of these transient tabs can contaminate its exact four-tab checkpoint.
  await page
    .getByRole("button", { name: PROJECT.name, exact: true })
    .and(page.locator("button"))
    .click();
  await waitUntil(
    "quick-open project selected",
    async () =>
      (await page
        .locator(`button[data-project-tile="${PROJECT.id}"]`)
        .getAttribute("aria-current")) === "true",
  );
  await waitUntil(
    "fresh quick-open Home strip",
    async () => (await readQuickOpenHomeTabs(page)).length === 0,
  );
  let shellSessionId = null;
  // Leave every independent check with the overlay closed, even on failure.
  // QO1 deliberately leaves it open for QO2's actual typing/Enter path.
  const probe = (id, label, run) =>
    attempt(id, label, async () => {
      try {
        return await run();
      } finally {
        await closeQuickOpen(page);
      }
    });
  try {
    // ---- 1. The chord, and the Main index -----------------------------------
    await must("QO1", "⌘P over Home opens the overlay listing the MAIN checkout", async () => {
      await openQuickOpen(page);
      const rows = await quickOpenRows(page);
      return {
        ok: rows.some((row) => row.includes(MAIN_FILE)) && rows.length >= 4,
        detail: `rows=${rows.length} ${JSON.stringify(rows.slice(0, 5))}`,
      };
    });

    // ---- 2. Typing narrows; Enter PREVIEWS ----------------------------------
    await must(
      "QO2",
      "typing narrows by name, and Enter opens ONE preview Home File tab",
      async () => {
        await page.keyboard.type("alphawid");
        const rows = await waitUntil("alphawid fuzzy match", async () => {
          const matches = await quickOpenRows(page);
          return matches.length === 1 && matches[0].includes("alpha-widget.ts") ? matches : null;
        });
        await page.keyboard.press("Enter");
        await waitUntil(
          "one Home File tab",
          async () => (await readQuickOpenHomeTabs(page)).length === 1,
        );
        const tabs = await readQuickOpenHomeTabs(page);
        return {
          ok:
            rows.length === 1 &&
            rows[0].includes("alpha-widget.ts") &&
            tabs[0]?.relPath === ALPHA_TS &&
            tabs[0]?.preview === "true" &&
            tabs[0]?.active === true &&
            (await quickOpenList(page).count()) === 0,
          detail: `matched=${JSON.stringify(rows)} tabs=${JSON.stringify(tabs)}`,
        };
      },
    );

    // ---- 3. A second invoke pins --------------------------------------------
    await probe("QO3", "a second invoke of the file in front PINS it", async () => {
      await openQuickOpen(page, "alphawid");
      await page.keyboard.press("Enter");
      await waitUntil(
        "tab pinned",
        async () => (await readQuickOpenHomeTabs(page))[0]?.preview === "false",
      );
      const tabs = await readQuickOpenHomeTabs(page);
      return {
        ok: tabs.length === 1 && tabs[0].preview === "false" && tabs[0].active,
        detail: JSON.stringify(tabs),
      };
    });

    // ---- 4. ⌘Enter pins outright --------------------------------------------
    await probe("QO4", "⌘⏎ opens a file straight into a PINNED tab", async () => {
      await openQuickOpen(page, "gammanotes");
      await page.keyboard.press("Meta+Enter");
      await waitUntil(
        "second Home File tab",
        async () => (await readQuickOpenHomeTabs(page)).length === 2,
      );
      const tabs = await readQuickOpenHomeTabs(page);
      const gamma = tabs.find((tab) => tab.relPath === GAMMA_MD);
      return {
        ok: gamma?.preview === "false" && gamma.active === true,
        detail: JSON.stringify(tabs),
      };
    });

    // ---- 5. The worked example, ranked in a running app ---------------------
    await probe("QO5", "`README` offers the root README.md first, and Enter opens IT", async () => {
      await openQuickOpen(page, "README");
      const rows = await quickOpenRows(page);
      // Both are in the index; only the order is under test. A row reads
      // "<basename><its folder>", so the root README's is bare.
      const offersArtifact = rows.some((r) => r.includes("audit-motion-perf.md"));
      await page.keyboard.press("Enter");
      await waitUntil("README File tab in front", async () =>
        (await readQuickOpenHomeTabs(page)).some((t) => t.relPath === ROOT_README && t.active),
      );
      const tabs = await readQuickOpenHomeTabs(page);
      const readme = tabs.find((tab) => tab.relPath === ROOT_README);
      return {
        ok:
          rows[0]?.startsWith("README.md") === true &&
          offersArtifact &&
          readme?.preview === "true" &&
          readme.active === true,
        detail: `rows=${JSON.stringify(rows.slice(0, 3))} tabs=${JSON.stringify(tabs)}`,
      };
    });

    // ---- A real ticket worktree ---------------------------------------------
    const { projectId, ticketId, displayId } = await createTicketViaBridge(page, PROJECT.name, {
      status: "todo",
      title: "Quick-open scope proof",
      priority: "medium",
    });
    const created = await page.evaluate(
      ({ workspaceId, cwd, tid }) =>
        window.api.terminal.create({
          workspaceId,
          cwd,
          cols: 80,
          rows: 24,
          ticket: { ticketId: tid },
        }),
      { workspaceId: projectId, cwd: projectPath, tid: ticketId },
    );
    if (!created.ok) throw new Error(`terminal.create failed: ${created.error}`);
    shellSessionId = created.sessionId;
    if (created.session.launchKind !== "shell" || created.session.activeHarnessId !== null) {
      throw new Error("quick-open worktree materializer must be a bare shell, not an agent");
    }

    const row = await waitUntil(
      "ticket row stamped with worktreePath",
      async () => {
        const tickets = await page.evaluate(async (pid) => {
          const boot = await window.api.data.bootstrap();
          return boot.ok ? (boot.data.ticketsByProject?.[pid] ?? []) : [];
        }, projectId);
        const found = tickets.find((ticket) => ticket.id === ticketId);
        return found?.worktreePath ? found : null;
      },
      { timeout: 40000 },
    );
    const worktreeDir = row.worktreePath;
    if (created.session.cwd !== worktreeDir || worktreeDir === projectPath) {
      throw new Error(
        `shell worktree cwd mismatch: session=${created.session.cwd} ticket=${worktreeDir} main=${projectPath}`,
      );
    }
    await fs.writeFile(join(worktreeDir, WORKTREE_ONLY), "export const w = 1;\n");
    await fs.writeFile(join(worktreeDir, WORKTREE_SECOND), "export const s = 1;\n");
    // Into MAIN only, and only now: everything committed before the cut lives in
    // both checkouts and could not tell the two scopes apart.
    await fs.writeFile(join(projectPath, MAIN_ONLY), "export const mu = 1;\n");

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await waitUntil("app surface", () =>
      page.evaluate(() => document.querySelector("[data-volli-surface]") !== null),
    );
    // Home restored a File tab; the board (and its cards) sit behind the Board tab.
    const boardTab = page.locator('[role="tab"]', { hasText: "Board" }).first();
    await waitUntil("Board tab", async () => (await boardTab.count()) === 1);
    await boardTab.click();
    await sleep(400);
    const card = page
      .locator("article")
      .filter({ visible: true })
      .filter({
        has: page.locator("span.font-mono", { hasText: new RegExp(`^${displayId}$`) }),
      });
    await waitUntil("ticket card", async () => (await card.count()) === 1);
    await card.dblclick();
    await waitUntil("ticket detail", async () => (await page.getByRole("tablist").count()) >= 1);

    // ---- 6. Scope follows the surface ---------------------------------------
    await probe("QO6", "in the Ticket view ⌘P indexes THAT WORKTREE, not Main", async () => {
      await openQuickOpen(page);
      const rows = await quickOpenRows(page);
      const offersWorktreeFile = rows.some((r) => r.includes(WORKTREE_ONLY));
      const offersMainOnlyFile = rows.some((r) => r.includes(MAIN_ONLY));
      await closeQuickOpen(page);
      return {
        ok: offersWorktreeFile && !offersMainOnlyFile,
        detail: `worktreeOnly=${offersWorktreeFile} mainOnly=${offersMainOnlyFile} rows=${rows.length}`,
      };
    });

    // ---- 7. The pick lands in the surface it was invoked from ----------------
    const homeTabsBeforeTicketPick = await readQuickOpenHomeTabs(page);
    await probe("QO7", "Enter previews into the TICKET's own tab strip", async () => {
      await openQuickOpen(page, "worktreeonly");
      await page.keyboard.press("Enter");
      await waitUntil(
        "ticket File tab in front",
        async () => ticketTab(await readTicketTabs(page), WORKTREE_ONLY)?.active === true,
      );
      const tabs = await readTicketTabs(page);
      const tab = ticketTab(tabs, WORKTREE_ONLY);
      const homeTabsAfter = await readQuickOpenHomeTabs(page);
      const sameHome = JSON.stringify(homeTabsAfter) === JSON.stringify(homeTabsBeforeTicketPick);
      return {
        ok:
          tab?.preview === "true" &&
          tab.active &&
          sameHome &&
          (await quickOpenList(page).count()) === 0,
        detail: `ticket=${JSON.stringify(tabs)} homeUnchanged=${sameHome}`,
      };
    });

    // ---- 8. ⌘⏎ on an open-but-behind ticket file brings it to the front ------
    await probe(
      "QO8",
      "⌘⏎ on a ticket file already open BUT BEHIND brings it to the front",
      async () => {
        await openQuickOpen(page, "worktreeonly");
        await page.keyboard.press("Meta+Enter");
        await waitUntil("first file pinned", async () => {
          const tab = ticketTab(await readTicketTabs(page), WORKTREE_ONLY);
          return tab?.active === true && tab.preview !== "true";
        });
        // Put another file in front, so the target is open-and-behind.
        await openQuickOpen(page, "secondworktree");
        await page.keyboard.press("Meta+Enter");
        await waitUntil(
          "second file in front",
          async () => ticketTab(await readTicketTabs(page), WORKTREE_SECOND)?.active === true,
        );
        await openQuickOpen(page, "worktreeonly");
        await page.keyboard.press("Meta+Enter");
        await waitUntil(
          "target back in front",
          async () => ticketTab(await readTicketTabs(page), WORKTREE_ONLY)?.active === true,
          { timeout: 8000 },
        );
        const tabs = await readTicketTabs(page);
        const target = ticketTab(tabs, WORKTREE_ONLY);
        return {
          ok:
            target?.active === true &&
            target.preview !== "true" &&
            tabs.filter((tab) => tab.label === WORKTREE_ONLY).length === 1 &&
            (await quickOpenList(page).count()) === 0,
          detail: JSON.stringify(tabs),
        };
      },
    );
  } finally {
    try {
      await closeQuickOpen(page);
    } finally {
      if (shellSessionId !== null) {
        await attempt("QO-cleanup", "quick-open materializer shell stops", async () => {
          const killed = await page.evaluate((id) => window.api.terminal.kill(id), shellSessionId);
          return { ok: killed.ok, detail: killed.ok ? shellSessionId : killed.error };
        });
      }
    }
  }
}

// ---- main ------------------------------------------------------------------

async function main() {
  const { attempt, must, summarize } = createRunner();
  const monacoRuntimeFailures = [];

  // A REAL git repo (Home's Files navigator is rooted in the project's Main
  // checkout), with everything committed so the navigator lists tracked files.
  const projectDir = await makeGitRepo(scratch, "project-");
  await fs.mkdir(join(projectDir, "src"), { recursive: true });
  await fs.mkdir(join(projectDir, "lib"), { recursive: true });
  await fs.writeFile(join(projectDir, APP_TS), APP_TS_CONTENT, "utf8");
  await fs.writeFile(join(projectDir, UTIL_TS), UTIL_TS_CONTENT, "utf8");
  await fs.writeFile(join(projectDir, LIB_APP_TS), LIB_APP_TS_CONTENT, "utf8");
  await execFileAsync("git", ["add", "-A"], { cwd: projectDir });
  await execFileAsync("git", ["commit", "-q", "-m", "seed files"], { cwd: projectDir });

  const quickOpenProjectDir = await makeQuickOpenRepo();

  let app = await launch({ dbPath, userDataDir });

  try {
    // Profile isolation guard: a leaked default profile would corrupt real data.
    await assertProfileIsolated(app, userDataDir);

    let page = await app.firstWindow();
    watchForMonacoFailures(page, monacoRuntimeFailures);
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    await seedProjects(page, [
      { id: PROJECT_SEED_ID, name: PROJECT_NAME, path: projectDir, prefix: TICKET_PREFIX },
      { ...PROJECT, path: quickOpenProjectDir },
    ]);

    // ===================================================================
    // 1. HOME'S RAIL FILES NAVIGATOR LISTS THE REPO AT ITS ROOT
    // ===================================================================
    await attempt(
      1,
      "Home's rail Files navigator lists the seeded repo, and a row exposes Open in… plus Finder",
      async () => {
        await openHomeFilesRail(page);
        const rootRows = await waitUntil("root navigator rows", async () => {
          const readme = (await fileRow(page, README).count()) === 1;
          const src = (await fileRow(page, "src").count()) === 1;
          const lib = (await fileRow(page, "lib").count()) === 1;
          return readme && src && lib ? true : null;
        });
        // The external-app submenu remains useful before discovery completes:
        // Finder is always its one truthful fallback item.
        await fileRow(page, README).click({ button: "right" });
        const openIn = page.getByText("Open in…", { exact: true });
        const menuOpen = await waitUntil("Open in menu on a navigator row", async () =>
          (await openIn.isVisible()) ? true : null,
        );
        if (menuOpen) await openIn.hover();
        const finder = page.getByText("Reveal in Finder", { exact: true });
        const finderVisible = await waitUntil("Finder fallback in Open in menu", async () =>
          (await finder.isVisible()) ? true : null,
        );
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        // Nothing is open yet, so no editor may be mounted.
        const monaco = await readMonaco(page);

        const ok = !!rootRows && !!menuOpen && !!finderVisible && monaco.hostCount === 0;
        return {
          ok,
          detail: `rootRows=${!!rootRows} openIn=${!!menuOpen} finder=${!!finderVisible} monacoHosts=${monaco.hostCount}`,
        };
      },
    );

    // ===================================================================
    // 2. SINGLE CLICK OPENS ONE PREVIEW TAB WITH A REAL MONACO EDITOR
    // ===================================================================
    await attempt(
      2,
      "Single-clicking src/app.ts opens exactly one PREVIEW Home File tab and a real Monaco editor (ready, no fallback)",
      async () => {
        await navigateIntoDir(page, "src", APP_TS);
        await fileRow(page, APP_TS).click();
        const tabs = await waitUntil("one preview tab", async () => {
          const strip = await readTabs(page);
          return strip.length === 1 && strip[0].relPath === APP_TS ? strip : null;
        });
        const monaco = await waitForMonacoReady(page, APP_TS, "src app");
        const previewed = tabs[0].preview === "true";
        const active = tabs[0].active;
        const noFallback = monaco.fallbacks === 0 && monacoRuntimeFailures.length === 0;
        const showsContent = monaco.lines.includes("src app");
        // CONCEPT #49: a repository file is an explicit-save EDITABLE document,
        // so neither our own contract attribute nor Monaco's rendered
        // accessible name may claim read-only (both signals, one predicate).
        const editable = isMonacoEditable(monaco);

        const ok =
          previewed && active && noFallback && showsContent && editable && monaco.hostCount === 1;
        return {
          ok,
          detail: `tabs=${tabSignature(tabs)} active=${active} status=${monaco.status} language=${monaco.language} worker=${monaco.worker} hosts=${monaco.hostCount} fallbacks=${monaco.fallbacks} content=${showsContent} editable=${editable} ariaLabel=${JSON.stringify(monaco.editorAriaLabel)}${monacoRuntimeFailures.length === 0 ? "" : ` runtimeFailures=${JSON.stringify(monacoRuntimeFailures)}`}`,
        };
      },
    );

    // ===================================================================
    // 3. A SECOND SINGLE CLICK REPLACES THE PREVIEW TAB
    // ===================================================================
    await attempt(
      3,
      "Single-clicking src/util.ts (same folder) REPLACES the preview tab in place — the strip still holds exactly one File tab",
      async () => {
        await fileRow(page, UTIL_TS).click();
        const tabs = await waitUntil("preview replaced by util.ts", async () => {
          const strip = await readTabs(page);
          return strip.length === 1 && strip[0].relPath === UTIL_TS ? strip : null;
        });
        await waitForMonacoReady(page, UTIL_TS);
        const ok = tabs.length === 1 && tabs[0].preview === "true" && tabs[0].active;
        return { ok, detail: `tabs=${tabSignature(tabs)} active=${tabs[0]?.active}` };
      },
    );

    // ===================================================================
    // 4. DOUBLE CLICK PINS; THE NEXT SINGLE CLICK OPENS A SECOND TAB
    // ===================================================================
    await attempt(
      4,
      "Double-click pins the preview tab, a later single click opens a SECOND tab beside it, and twin basenames get disambiguating hints",
      async () => {
        // (a) Pin the preview tab from the navigator row (double click = "keep open").
        await fileRow(page, UTIL_TS).dblclick();
        const pinned = await waitUntil(
          "util.ts pinned",
          async () => (await homeFileTab(page, UTIL_TS).getAttribute("data-preview")) === "false",
        );

        // (b) A single click no longer has a preview slot to steal → second tab
        // (src/app.ts is still listed here: navigating a FILE never moves the
        // navigator's folder).
        await fileRow(page, APP_TS).click();
        const two = await waitUntil("second tab beside the pinned one", async () => {
          const strip = await readTabs(page);
          return strip.length === 2 &&
            strip[0].relPath === UTIL_TS &&
            strip[1].relPath === APP_TS &&
            strip[1].preview === "true"
            ? strip
            : null;
        });

        // (c) Pin it too, from the strip this time, then (d) walk out to the
        // root and into lib/ to open its basename twin, so the strip has to
        // disambiguate two tabs both named "app.ts".
        await homeFileTab(page, APP_TS).dblclick();
        await waitUntil(
          "src/app.ts pinned from the strip",
          async () => (await homeFileTab(page, APP_TS).getAttribute("data-preview")) === "false",
        );
        await navigateToRoot(page);
        await navigateIntoDir(page, "lib", LIB_APP_TS);
        await fileRow(page, LIB_APP_TS).click();
        const three = await waitUntil("third tab with distinct basename identities", async () => {
          const strip = await readTabs(page);
          return strip.length === 3 &&
            strip[2].relPath === LIB_APP_TS &&
            strip[1].name === "app.ts · src" &&
            strip[2].name === "app.ts · lib"
            ? strip
            : null;
        });
        await waitForMonacoReady(page, LIB_APP_TS);
        // The compact captions keep the basename; sighted keyboard users can
        // still read each path through the real tab's focus reveal.
        for (const [relPath, detail] of [
          [APP_TS, "app.ts · src"],
          [LIB_APP_TS, "app.ts · lib"],
        ]) {
          await homeFileTab(page, relPath).focus();
          await waitUntil(
            `file location reveal: ${detail}`,
            async () => (await page.getByRole("tooltip").textContent()) === detail,
          );
          await page.keyboard.press("Escape");
        }
        const utilHasNoHint = three[0].name === "util.ts";

        const ok = !!pinned && two.length === 2 && three.length === 3 && utilHasNoHint;
        return {
          ok,
          detail: `tabs=${tabSignature(three)} names=${JSON.stringify(three.map((t) => t.name))}`,
        };
      },
    );

    // ===================================================================
    // 5. AN EDIT MARKS THE TAB DIRTY AND PINS IT
    // ===================================================================
    await attempt(
      5,
      "Typing into Monaco marks the active tab dirty and promotes the preview tab to persistent (decision #56)",
      async () => {
        const before = await homeFileTab(page, LIB_APP_TS).getAttribute("data-preview");
        await typeMarkerAtTop(page, EDIT_MARKER);
        const tab = await waitUntil("lib/app.ts dirty + pinned", async () => {
          const strip = await readTabs(page);
          const target = strip.find((t) => t.relPath === LIB_APP_TS);
          return target?.dirty === "true" && target.preview === "false" ? target : null;
        });
        // Polled, not read once: `data-monaco-dirty` and the rendered line text
        // land a paint after the tab strip's own dirty flag does.
        const monaco = await waitUntil(
          "editor dirty and showing the typed marker",
          async () => {
            const state = await readMonaco(page);
            if (state.dirty === "true" && state.lines.includes(EDIT_MARKER)) return state;
            throw new Error(
              `state=${JSON.stringify({
                dirty: state.dirty,
                readOnly: state.readOnly,
                lines: state.lines.slice(0, 120),
              })}`,
            );
          },
          { timeout: 15000 },
        );
        const editorDirty = monaco.dirty === "true";
        const typed = monaco.lines.includes(EDIT_MARKER);

        const ok = before === "true" && tab.dirty === "true" && editorDirty && typed;
        return {
          ok,
          detail: `previewBefore=${before} tabDirty=${tab?.dirty} tabPreview=${tab?.preview} editorDirty=${monaco.dirty} typedVisible=${typed} readOnly=${monaco.readOnly}`,
        };
      },
    );

    // ===================================================================
    // 6. ⌘S SAVES — AND THE BYTES ON DISK MATCH (the acceptance criterion)
    // ===================================================================
    await attempt(
      6,
      "⌘S saves the edit: the tab goes clean and the file READ BACK FROM DISK really contains the typed text",
      async () => {
        await page.keyboard.press("Meta+s");
        const clean = await waitUntil(
          "lib/app.ts tab clean after ⌘S",
          async () => (await homeFileTab(page, LIB_APP_TS).getAttribute("data-dirty")) === "false",
          { timeout: 15000 },
        );
        // The assertion that matters: real bytes, read with fs, not UI state.
        const onDisk = await fs.readFile(join(projectDir, LIB_APP_TS), "utf8");
        const hasMarker = onDisk.includes(EDIT_MARKER);
        const keptOriginal = onDisk.includes("lib app");
        const monaco = await readMonaco(page);

        const ok = !!clean && hasMarker && keptOriginal;
        return {
          ok,
          detail: `tabClean=${!!clean} diskHasMarker=${hasMarker} diskKeptOriginal=${keptOriginal} editorDirty=${monaco.dirty} saving=${monaco.saving} stale=${monaco.stale} disk=${JSON.stringify(onDisk.slice(0, 80))}`,
        };
      },
    );

    // ===================================================================
    // 7. A FULL RELAUNCH RESTORES THE WORKSPACE
    // ===================================================================
    // Home is always mounted now (CLAUDE.md's keep-alive seam), so there is no
    // more "leave the page, come back" gesture that unmounts and remounts the
    // File-tab surface the way switching to the old Files nav item once did.
    // A real relaunch is the only boundary left that proves decision #55 end
    // to end — and it is a STRONGER proof than the old one, since it goes
    // through the actual persist/rehydrate path a relaunch takes rather than a
    // same-process component remount.
    let beforeRelaunch = [];
    await attempt(
      7,
      "Closing and relaunching the app restores the same Home File tabs, in the same order, with the same pinned/preview flags and the same active tab",
      async () => {
        // Re-open a preview tab first, so the restored strip has to carry BOTH
        // kinds of tab (three pinned + one preview) rather than a uniform set.
        await navigateToRoot(page);
        await fileRow(page, README).click();
        beforeRelaunch = await waitUntil("README.md preview tab active", async () => {
          const strip = await readTabs(page);
          const target = strip.find((t) => t.relPath === README);
          return strip.length === 4 && target?.preview === "true" && target.active ? strip : null;
        });
        await waitForMonacoReady(page, README);

        // `volli:workspace` writes through a debounced SQLite bridge. Observe
        // the 4-tab workspace durably before releasing this window, or a fast
        // relaunch can race the write and land on a stale, shorter strip.
        await waitUntil("all four Home File tabs persisted before close", () =>
          page.evaluate(async (projectId) => {
            const boot = await window.api.data.bootstrap();
            if (!boot.ok) return false;
            const raw = boot.data.appState["volli:workspace"];
            if (typeof raw !== "string") return false;
            const record = JSON.parse(raw)?.state?.byProject?.[projectId];
            return (
              Array.isArray(record?.projectFiles?.tabs) && record.projectFiles.tabs.length === 4
            );
          }, PROJECT_SEED_ID),
        );

        await app.close();
        app = await launch({ dbPath, userDataDir });
        page = await app.firstWindow();
        watchForMonacoFailures(page, monacoRuntimeFailures);
        await page.waitForLoadState("domcontentloaded");

        const afterRelaunch = await waitUntil("tab strip restored", async () => {
          const strip = await readTabs(page);
          return strip.length === beforeRelaunch.length ? strip : null;
        });

        const sameOrder = tabSignature(afterRelaunch) === tabSignature(beforeRelaunch);
        const sameActive =
          afterRelaunch.find((t) => t.active)?.relPath ===
          beforeRelaunch.find((t) => t.active)?.relPath;

        const ok = sameOrder && sameActive;
        return {
          ok,
          detail: `before=${tabSignature(beforeRelaunch)} after=${tabSignature(afterRelaunch)} activeBefore=${beforeRelaunch.find((t) => t.active)?.relPath} activeAfter=${afterRelaunch.find((t) => t.active)?.relPath}`,
        };
      },
    );

    // ===================================================================
    // 8. RESTORATION IS LAZY — ONLY THE ACTIVE TAB MOUNTS AN EDITOR
    // ===================================================================
    // What this proves: with four tabs restored, exactly ONE Monaco host
    // exists in the DOM, so the three inactive tabs mounted no editor — and
    // since a FileView is what issues `api.files.read`, they read no file
    // content either. Restored inactive tabs carry identity (relPath, pinned
    // flag, serialized cursor state) and nothing more.
    // What it does NOT prove: that literally nothing in the app touched those
    // paths. Main-process directory watches, git, and the navigator's own
    // listing all run regardless; this check is about the EDITOR/content
    // tier, which is where decision #55's cost lives (a ten-tab strip must
    // not perform ten reads).
    await attempt(
      8,
      "Lazy restoration: with four tabs restored, exactly ONE Monaco host is mounted (the active tab's) and no fallback appeared",
      async () => {
        const monaco = await waitForMonacoReady(page, `${README} (restored)`, "smoke project");
        const oneHost = monaco.hostCount === 1;
        const isActiveTab = monaco.lines.includes("smoke project"); // README.md's body
        const noFallback = monaco.fallbacks === 0 && monacoRuntimeFailures.length === 0;

        const ok = oneHost && isActiveTab && noFallback;
        return {
          ok,
          detail: `hosts=${monaco.hostCount} tabs=${(await readTabs(page)).length} activeContent=${isActiveTab} language=${monaco.language} fallbacks=${monaco.fallbacks}${monacoRuntimeFailures.length === 0 ? "" : ` runtimeFailures=${JSON.stringify(monacoRuntimeFailures)}`}`,
        };
      },
    );

    // ===================================================================
    // 9. THE DIRTY-CLOSE GUARD: CANCEL KEEPS, SAVE WRITES THEN CLOSES
    // ===================================================================
    await attempt(
      9,
      "Closing a dirty tab raises the save guard: Cancel keeps it open and still dirty; Save writes the bytes to disk and closes it",
      async () => {
        await typeMarkerAtTop(page, GUARD_MARKER);
        await waitUntil(
          "README.md dirty",
          async () => (await homeFileTab(page, README).getAttribute("data-dirty")) === "true",
        );

        // --- Cancel: nothing changes ---
        await closeButtonFor(page, README).click();
        await waitUntil("save guard shown", async () => (await saveGuard(page).count()) === 1);
        await page.locator('[data-testid="file-save-guard-cancel"]').click();
        await waitUntil("save guard dismissed", async () => (await saveGuard(page).count()) === 0);
        const keptOpen = await waitUntil("tab kept open and dirty after Cancel", async () => {
          const strip = await readTabs(page);
          const target = strip.find((t) => t.relPath === README);
          return target?.dirty === "true" ? target : null;
        });
        const onDiskAfterCancel = await fs.readFile(join(projectDir, README), "utf8");
        const cancelWroteNothing = !onDiskAfterCancel.includes(GUARD_MARKER);

        // --- Save: bytes land, then the tab closes ---
        await closeButtonFor(page, README).click();
        await waitUntil(
          "save guard shown again",
          async () => (await saveGuard(page).count()) === 1,
        );
        await page.locator('[data-testid="file-save-guard-save"]').click();
        const closed = await waitUntil(
          "tab closed after Save",
          async () => (await homeFileTab(page, README).count()) === 0,
          { timeout: 15000 },
        );
        const onDiskAfterSave = await fs.readFile(join(projectDir, README), "utf8");
        const saved = onDiskAfterSave.includes(GUARD_MARKER);

        const ok = !!keptOpen && cancelWroteNothing && !!closed && saved;
        return {
          ok,
          detail: `cancelKeptDirty=${keptOpen?.dirty} cancelWroteNothing=${cancelWroteNothing} closedAfterSave=${!!closed} diskHasMarker=${saved} disk=${JSON.stringify(onDiskAfterSave.slice(0, 80))}`,
        };
      },
    );

    // ===================================================================
    // 10. LIVE DIRECTORY REFRESH (no manual refresh)
    // ===================================================================
    await attempt(
      10,
      "A file created on disk inside the navigator's open src/ folder appears with no manual refresh",
      async () => {
        await openHomeFilesRail(page);
        await navigateIntoDir(page, "src", APP_TS);
        const absent = (await fileRow(page, APPEARED_TS).count()) === 0;
        await fs.writeFile(
          join(projectDir, APPEARED_TS),
          'export const appeared = "live";\n',
          "utf8",
        );
        const appeared = await waitUntil(
          "src/appeared.ts row in the navigator",
          async () => (await fileRow(page, APPEARED_TS).count()) === 1,
          { timeout: 20000 },
        );
        const ok = absent && !!appeared;
        return { ok, detail: `absentBefore=${absent} appeared=${!!appeared}` };
      },
    );

    await runQuickOpenChecks(page, quickOpenProjectDir, { attempt, must });

    if (monacoRuntimeFailures.length > 0) {
      console.log(`\nMonaco runtime failures observed: ${JSON.stringify(monacoRuntimeFailures)}`);
    }
  } finally {
    await app.close().catch(() => {});
  }

  return summarize();
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error("\nSMOKE ABORTED:", error?.stack ?? error);
  code = 1;
} finally {
  await cleanup();
}
process.exit(code);
