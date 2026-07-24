/**
 * End-to-end acceptance smoke for PROJECT FILES AS A RESUMABLE MONACO WORKSPACE
 * (issue #106, CONCEPT #49/#54/#55/#56). Drives the REAL packaged renderer
 * through Playwright against a scratch SQLite database (`VOLLI_DB_PATH`) + an
 * isolated user-data dir, over a REAL git repository seeded on disk.
 *
 * This is the issue's final acceptance criterion, executed end to end: open a
 * file from the left tree, edit and save it, verify the bytes on disk, navigate
 * away and back, and verify lazy workspace restoration.
 *
 *   1. Tree lists the seeded repo — the Files nav lands on the workbench with
 *      its empty state, and the sidebar tree lists the repo's directories and
 *      files (root, plus `src/` and `lib/` once expanded).
 *   2. Single click opens ONE preview tab — italic/replaceable
 *      (`data-preview="true"`), with a real Monaco editor reaching
 *      `data-monaco-status="ready"` and NO `data-monaco-fallback` anywhere.
 *   3. Single-clicking a second file REPLACES the preview tab in place — the
 *      strip still holds exactly one tab.
 *   4. Double click PINS — the tab turns persistent (`data-preview="false"`),
 *      a later single click opens a SECOND tab beside it instead of replacing
 *      it, and two open tabs sharing a basename get disambiguating hints.
 *   5. Editing marks the tab dirty AND pins it — typing into Monaco flips the
 *      tab to `data-dirty="true"` and promotes the preview slot to persistent
 *      (decision #56: a dirty tab is never replaced).
 *   6. ⌘S saves, and DISK BYTES match — the tab goes clean and the file read
 *      back with `fs` really contains the typed text. This is the core of the
 *      acceptance criterion: real bytes, not UI state.
 *   7. Navigate away and back RESTORES the workspace — Board, then Files: the
 *      same tabs, in the same order, with the same pinned/preview flags and the
 *      same active tab.
 *   8. Restoration is LAZY — on return, exactly ONE Monaco host is mounted (the
 *      active tab's). Inactive tabs restore identity only, never contents.
 *   9. Dirty close is GUARDED — closing a dirty tab raises the save guard;
 *      Cancel keeps it open and still dirty; Save closes it and the new bytes
 *      are on disk.
 *  10. Directory refresh is LIVE — a file created on disk inside an expanded
 *      directory appears in the tree with no manual refresh.
 *
 * Every assertion polls (expect-style waits); no bare sleep stands in for a
 * condition (the few fixed sleeps only pace UI settling, never assert).
 *
 * This is a MANUALLY-RUN smoke (it needs a display + the built app); it is NOT
 * wired into `vp test` and does NOT run in CI (CI minutes are rationed — see
 * CLAUDE.md). It is local proof for desktop-touching PRs.
 *
 *   Run:
 *     vp run --filter @volli/desktop build   # produce dist/ + dist-electron/
 *     node apps/desktop/e2e/project-files-smoke.mjs
 *
 *   Requires: playwright-core (devDependency of @volli/desktop).
 *   Exit code is non-zero if any numbered check fails.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  assertProfileIsolated,
  createRunner,
  launch,
  makeGitRepo,
  makeScratch,
  seedProjects,
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const execFileAsync = promisify(execFile);

const { userDataDir, dbPath, scratch, cleanup } = await makeScratch("volli-project-files-smoke-");

const PROJECT_SEED_ID = "project-files-project";
const PROJECT_NAME = "Project Files Project";
const TICKET_PREFIX = "PF";

// ---- the seeded repository -------------------------------------------------
// `lib/app.ts` deliberately shares its basename with `src/app.ts`: opening both
// is what makes the tab strip render disambiguating hints (check 4).
const APP_TS = "src/app.ts";
const UTIL_TS = "src/util.ts";
const LIB_APP_TS = "lib/app.ts";
const README = "README.md";
/** Created on disk mid-run, inside the already-expanded `src/` (check 10). */
const APPEARED_TS = "src/appeared.ts";

const APP_TS_CONTENT = 'export const app = "src app";\n';
const UTIL_TS_CONTENT = 'export const util = "src util";\n';
const LIB_APP_TS_CONTENT = 'export const app = "lib app";\n';

// Markers are typed through the real keyboard, so they hold no characters
// Monaco would auto-close or auto-indent (quotes, brackets, list bullets).
const EDIT_MARKER = "// PF-EDIT-MARKER-1";
const GUARD_MARKER = "PF-GUARD-MARKER-2";

// ---- DOM helpers -----------------------------------------------------------

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

function tabFor(page, relPath) {
  return page.locator(`[data-testid="file-tab"][data-rel-path="${relPath}"]`);
}

function closeButtonFor(page, relPath) {
  return page.locator(`[data-testid="file-tab-close"][data-rel-path="${relPath}"]`);
}

function saveGuard(page) {
  return page.locator('[data-testid="file-save-guard"]');
}

/** The whole strip, left to right — order, identity and per-tab state in one read. */
async function readTabs(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="file-tab"]')).map((tab) => ({
      relPath: tab.getAttribute("data-rel-path"),
      preview: tab.getAttribute("data-preview"),
      dirty: tab.getAttribute("data-dirty"),
      active: tab.getAttribute("aria-selected") === "true",
      hint: tab.querySelector('[data-testid="file-tab-hint"]')?.textContent ?? null,
    })),
  );
}

/** A compact, loggable signature of the strip (what check 7 compares across nav). */
function tabSignature(tabs) {
  return tabs.map((t) => `${t.relPath}[${t.preview === "true" ? "preview" : "pinned"}]`).join(" ");
}

/**
 * Every mounted Monaco host plus the fallback signal. `hostCount` is the lazy-
 * restoration probe (check 8) and `fallbacks` is a hard failure signal anywhere
 * it appears — the degraded `<pre data-monaco-fallback="true">` means the real
 * editor never booted.
 */
async function readMonaco(page) {
  return page.evaluate(() => {
    const hosts = Array.from(document.querySelectorAll("[data-monaco-status]"));
    const host = hosts[0] ?? null;
    const editor = host?.querySelector(".monaco-editor") ?? null;
    // Monaco's input surface in this build is a `native-edit-context` div (the
    // only <textarea> under .monaco-editor is the permanently-readonly IME
    // helper, so its `readonly` attribute says nothing about the document).
    // `textarea.inputarea` covers the older input strategy.
    const input = editor?.querySelector(".native-edit-context, textarea.inputarea") ?? null;
    return {
      hostCount: hosts.length,
      fallbacks: document.querySelectorAll("[data-monaco-fallback]").length,
      status: host?.getAttribute("data-monaco-status") ?? null,
      language: host?.getAttribute("data-monaco-language") ?? null,
      worker: host?.getAttribute("data-monaco-worker") ?? null,
      readOnly: host?.getAttribute("data-monaco-read-only") ?? null,
      dirty: host?.getAttribute("data-monaco-dirty") ?? null,
      saving: host?.getAttribute("data-monaco-saving") ?? null,
      stale: host?.getAttribute("data-monaco-stale") ?? null,
      hasEditor: editor !== null,
      // The editor's RENDERED accessible name — `fileEditorAriaLabel` appends
      // ", read-only" only for a read-only view, so this is the honest
      // editability signal from Monaco's own DOM rather than from our props.
      editorAriaLabel: input?.getAttribute("aria-label") ?? null,
      // Monaco renders spaces as non-breaking spaces, so the rendered line text
      // never string-matches source bytes until they are normalized back.
      lines: Array.from(editor?.querySelectorAll(".view-line") ?? [])
        .map((line) => (line.textContent ?? "").replace(/\u00a0/g, " "))
        .join("\n"),
    };
  });
}

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

/** Expand a tree directory, identified by a child file that must become visible. */
async function expandDir(page, relPath, expectChild) {
  await waitUntil(
    `tree row for ${relPath}/`,
    async () => (await treeDir(page, relPath).count()) === 1,
  );
  if ((await treeFile(page, expectChild).count()) === 0) {
    await treeDir(page, relPath).click();
  }
  await waitUntil(
    `tree row for ${expectChild}`,
    async () => (await treeFile(page, expectChild).count()) === 1,
  );
}

/** Click a nav item and wait for the page it opens to be genuinely on screen. */
async function goToNav(page, label, settled) {
  await navButton(page, label).click();
  await waitUntil(`${label} page to settle`, () => settled(), { timeout: 15000 });
}

const filesSettled = (page) => async () =>
  (await page.locator('[data-testid="files-workbench"]').count()) === 1;
/** The board has no test id of its own; its "New ticket" button is its landmark. */
const boardSettled = (page) => () =>
  page.getByRole("button", { name: "New ticket", exact: true }).isVisible();

// ---- main ------------------------------------------------------------------

async function main() {
  const { attempt, summarize } = createRunner();

  // A REAL git repo (the Files workbench is rooted in the project's Main
  // checkout), with everything committed so the tree lists tracked files.
  const projectDir = await makeGitRepo(scratch, "project-");
  await fs.mkdir(join(projectDir, "src"), { recursive: true });
  await fs.mkdir(join(projectDir, "lib"), { recursive: true });
  await fs.writeFile(join(projectDir, APP_TS), APP_TS_CONTENT, "utf8");
  await fs.writeFile(join(projectDir, UTIL_TS), UTIL_TS_CONTENT, "utf8");
  await fs.writeFile(join(projectDir, LIB_APP_TS), LIB_APP_TS_CONTENT, "utf8");
  await execFileAsync("git", ["add", "-A"], { cwd: projectDir });
  await execFileAsync("git", ["commit", "-q", "-m", "seed files"], { cwd: projectDir });

  const app = await launch({ dbPath, userDataDir });

  try {
    // Profile isolation guard: a leaked default profile would corrupt real data.
    await assertProfileIsolated(app, userDataDir);

    const page = await app.firstWindow();
    // Anything Monaco-shaped that reaches the console is a failure signal: the
    // whole point of the workbench is a REAL editor, so a worker/fallback
    // warning means we are silently running degraded.
    const monacoRuntimeFailures = [];
    page.on("console", (message) => {
      if (
        (message.type() === "warning" || message.type() === "error") &&
        /monaco|worker|fallback/i.test(message.text())
      ) {
        monacoRuntimeFailures.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => {
      if (/monaco|worker|fallback/i.test(error.message)) {
        monacoRuntimeFailures.push(`pageerror: ${error.message}`);
      }
    });
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    await seedProjects(page, [
      { id: PROJECT_SEED_ID, name: PROJECT_NAME, path: projectDir, prefix: TICKET_PREFIX },
    ]);

    // ===================================================================
    // 1. FILES NAV + THE SIDEBAR TREE LISTS THE REPO
    // ===================================================================
    await attempt(
      1,
      "Files nav opens the workbench (empty) and the sidebar tree lists the seeded repo, including nested src/ and lib/",
      async () => {
        await goToNav(page, "Files", filesSettled(page));
        const empty = await waitUntil(
          "files empty state",
          async () => (await page.locator('[data-testid="files-empty-state"]').count()) === 1,
        );
        const rootRows = await waitUntil("root tree rows", async () => {
          const readme = (await treeFile(page, README).count()) === 1;
          const src = (await treeDir(page, "src").count()) === 1;
          const lib = (await treeDir(page, "lib").count()) === 1;
          return readme && src && lib ? true : null;
        });
        // Expanded here so every later check can click a nested file, and so
        // check 10 has a live directory watch to prove.
        await expandDir(page, "src", APP_TS);
        await expandDir(page, "lib", LIB_APP_TS);
        const nested = (await treeFile(page, UTIL_TS).count()) === 1;
        // Nothing is open yet, so no editor may be mounted.
        const monaco = await readMonaco(page);

        const ok = !!empty && !!rootRows && nested && monaco.hostCount === 0;
        return {
          ok,
          detail: `empty=${!!empty} rootRows=${!!rootRows} nested=${nested} monacoHosts=${monaco.hostCount}`,
        };
      },
    );

    // ===================================================================
    // 2. SINGLE CLICK OPENS ONE PREVIEW TAB WITH A REAL MONACO EDITOR
    // ===================================================================
    await attempt(
      2,
      "Single-clicking src/app.ts opens exactly one PREVIEW tab and a real Monaco editor (ready, no fallback)",
      async () => {
        await treeFile(page, APP_TS).click();
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
        // accessible name may claim read-only.
        const editable =
          monaco.readOnly === "false" &&
          monaco.editorAriaLabel !== null &&
          !monaco.editorAriaLabel.endsWith(", read-only");

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
      "Single-clicking src/util.ts REPLACES the preview tab in place — the strip still holds exactly one tab",
      async () => {
        await treeFile(page, UTIL_TS).click();
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
        // (a) Pin the preview tab from the tree (double click = "keep open").
        await treeFile(page, UTIL_TS).dblclick();
        const pinned = await waitUntil(
          "util.ts pinned",
          async () => (await tabFor(page, UTIL_TS).getAttribute("data-preview")) === "false",
        );

        // (b) A single click no longer has a preview slot to steal → second tab.
        await treeFile(page, APP_TS).click();
        const two = await waitUntil("second tab beside the pinned one", async () => {
          const strip = await readTabs(page);
          return strip.length === 2 &&
            strip[0].relPath === UTIL_TS &&
            strip[1].relPath === APP_TS &&
            strip[1].preview === "true"
            ? strip
            : null;
        });

        // (c) Pin it too, from the strip this time, then (d) open its basename
        // twin so the strip has to disambiguate two tabs both named "app.ts".
        await tabFor(page, APP_TS).dblclick();
        await waitUntil(
          "src/app.ts pinned from the strip",
          async () => (await tabFor(page, APP_TS).getAttribute("data-preview")) === "false",
        );
        await treeFile(page, LIB_APP_TS).click();
        const three = await waitUntil("third tab with basename hints", async () => {
          const strip = await readTabs(page);
          return strip.length === 3 &&
            strip[2].relPath === LIB_APP_TS &&
            strip[1].hint === "src" &&
            strip[2].hint === "lib"
            ? strip
            : null;
        });
        await waitForMonacoReady(page, LIB_APP_TS);
        const utilHasNoHint = three[0].hint === null;

        const ok = !!pinned && two.length === 2 && three.length === 3 && utilHasNoHint;
        return {
          ok,
          detail: `tabs=${tabSignature(three)} hints=${JSON.stringify(three.map((t) => t.hint))}`,
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
        const before = await tabFor(page, LIB_APP_TS).getAttribute("data-preview");
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
          async () => (await tabFor(page, LIB_APP_TS).getAttribute("data-dirty")) === "false",
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
    // 7. NAVIGATE AWAY AND BACK RESTORES THE WORKSPACE
    // ===================================================================
    let beforeNav = [];
    await attempt(
      7,
      "Board → Files restores the same tabs, in the same order, with the same pinned/preview flags and the same active tab",
      async () => {
        // Re-open a preview tab first, so the restored strip has to carry BOTH
        // kinds of tab (three pinned + one preview) rather than a uniform set.
        await treeFile(page, README).click();
        beforeNav = await waitUntil("README.md preview tab active", async () => {
          const strip = await readTabs(page);
          const target = strip.find((t) => t.relPath === README);
          return strip.length === 4 && target?.preview === "true" && target.active ? strip : null;
        });
        await waitForMonacoReady(page, README);

        await goToNav(page, "Board", boardSettled(page));
        // The workbench is genuinely gone, not merely hidden.
        const unmounted = await waitUntil(
          "files workbench unmounted on Board",
          async () => (await page.locator('[data-testid="files-workbench"]').count()) === 0,
        );

        await goToNav(page, "Files", filesSettled(page));
        const afterNav = await waitUntil("tab strip restored", async () => {
          const strip = await readTabs(page);
          return strip.length === beforeNav.length ? strip : null;
        });

        const sameOrder = tabSignature(afterNav) === tabSignature(beforeNav);
        const sameActive =
          afterNav.find((t) => t.active)?.relPath === beforeNav.find((t) => t.active)?.relPath;

        const ok = !!unmounted && sameOrder && sameActive;
        return {
          ok,
          detail: `before=${tabSignature(beforeNav)} after=${tabSignature(afterNav)} activeBefore=${beforeNav.find((t) => t.active)?.relPath} activeAfter=${afterNav.find((t) => t.active)?.relPath} unmounted=${!!unmounted}`,
        };
      },
    );

    // ===================================================================
    // 8. RESTORATION IS LAZY — ONLY THE ACTIVE TAB MOUNTS AN EDITOR
    // ===================================================================
    // What this proves: with four tabs restored, exactly ONE Monaco host exists
    // in the DOM, so the three inactive tabs mounted no editor — and since a
    // FileView is what issues `api.files.read`, they read no file content
    // either. Restored inactive tabs carry identity (relPath, pinned flag,
    // serialized cursor state) and nothing more.
    // What it does NOT prove: that literally nothing in the app touched those
    // paths. Main-process directory watches, git, and the tree listing all run
    // regardless; this check is about the EDITOR/content tier, which is where
    // decision #55's cost lives (a ten-tab strip must not perform ten reads).
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
          async () => (await tabFor(page, README).getAttribute("data-dirty")) === "true",
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
          async () => (await tabFor(page, README).count()) === 0,
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
      "A file created on disk inside the expanded src/ appears in the tree with no manual refresh",
      async () => {
        const absent = (await treeFile(page, APPEARED_TS).count()) === 0;
        await fs.writeFile(
          join(projectDir, APPEARED_TS),
          'export const appeared = "live";\n',
          "utf8",
        );
        const appeared = await waitUntil(
          "src/appeared.ts row in the tree",
          async () => (await treeFile(page, APPEARED_TS).count()) === 1,
          { timeout: 20000 },
        );
        const ok = absent && !!appeared;
        return { ok, detail: `absentBefore=${absent} appeared=${!!appeared}` };
      },
    );

    if (monacoRuntimeFailures.length > 0) {
      console.log(`\nMonaco runtime failures observed: ${JSON.stringify(monacoRuntimeFailures)}`);
    }
  } finally {
    await app.close();
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
