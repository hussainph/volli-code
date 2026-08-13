/**
 * End-to-end smoke for Monaco editor theming (issue #122).
 *
 * Drives the REAL packaged app through Playwright against an isolated profile
 * and a seeded git repo. Proves what unit tests cannot see:
 *
 *   1. Opening a project file boots a real Monaco editor (ready, no fallback).
 *   2. The default Ember → One Dark Pro catalog theme paints Monaco's
 *      editor.background (not an unthemed / volli-dark surface).
 *   3. Settings → Appearance → Editor theme commit persists via
 *      `window.api.theme` and survives returning to Files.
 *   4. After committing Nord, Monaco's background matches Nord's
 *      editor.background — proof setTheme applied a catalog id.
 *   5. Source Mode and Document Mode part ways under that same committed
 *      catalog theme: a markdown file paints NO catalog background and takes
 *      its ink from `--foreground` (document-mode.css), which is the split
 *      nothing but a real window can see.
 *
 * MANUALLY RUN (needs a display + the built app); not wired into CI:
 *
 *   pnpm -C apps/desktop run build
 *   node apps/desktop/e2e/editor-theme-smoke.mjs
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
  readMonacoState,
  seedProjects,
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const execFileAsync = promisify(execFile);

if (process.platform !== "darwin") {
  console.error(
    `editor-theme-smoke is macOS-only (got platform "${process.platform}"): it shares the Files / Monaco path with project-files-smoke.`,
  );
  process.exit(1);
}

/** Shiki catalog editor.background pins — independent of the generator. */
const ONE_DARK_PRO_BG = "#282c34";
const NORD_BG = "#2e3440";

const PROJECT_SEED_ID = "editor-theme-project";
const PROJECT_NAME = "Editor Theme Project";
const TICKET_PREFIX = "ET";
const APP_TS = "src/app.ts";
const APP_TS_CONTENT = 'export const app = "theme probe";\n';
/** A markdown file in the workbench IS Document Mode (FileView's markdown branch). */
const NOTES_MD = "notes.md";
const NOTES_MD_CONTENT = "# Document probe\n\nProse on the page.\n";

const { userDataDir, dbPath, scratch, cleanup } = await makeScratch("volli-editor-theme-smoke-");
const { check, attempt, summarize } = createRunner();

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

function editorThemeTrigger(page) {
  return page.getByRole("button", { name: "Editor theme", exact: true });
}

async function goToNav(page, label, settled) {
  await navButton(page, label).click();
  await waitUntil(`${label} page to settle`, () => settled(), { timeout: 15000 });
}

const filesSettled = (page) => async () =>
  (await page.locator('[data-testid="files-workbench"]').count()) === 1;

async function openAppearanceSettings(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await editorThemeTrigger(page).waitFor();
}

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

async function waitForMonacoReady(page, needle) {
  return waitUntil(
    `Monaco ready showing ${JSON.stringify(needle)}`,
    async () => {
      const state = await readMonacoState(page);
      if (
        state.status === "ready" &&
        state.hasEditor &&
        state.fallbacks === 0 &&
        state.lines.includes(needle)
      ) {
        return state;
      }
      throw new Error(`state=${JSON.stringify({ ...state, lines: state.lines.slice(0, 200) })}`);
    },
    { timeout: 30000 },
  );
}

/** Monaco paints background as rgb(); normalize to lowercase #rrggbb. */
function cssColorToHex(css) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css.trim());
  if (hex) {
    const raw = hex[1];
    if (raw.length === 3) {
      return `#${raw
        .split("")
        .map((c) => c + c)
        .join("")}`.toLowerCase();
    }
    return `#${raw}`.toLowerCase();
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(css);
  if (!rgb) return css.trim().toLowerCase();
  return `#${[rgb[1], rgb[2], rgb[3]]
    .map((n) => Number(n).toString(16).padStart(2, "0"))
    .join("")}`;
}

async function readMonacoBackground(page) {
  return page.evaluate(() => {
    const editor = document.querySelector("[data-monaco-status] .monaco-editor");
    if (editor === null) return null;
    // Monaco sets background on the root and/or overflow guard; prefer the
    // computed background that is actually filled (not transparent).
    const nodes = [
      editor,
      ...editor.querySelectorAll(".overflow-guard, .monaco-editor-background"),
    ];
    for (const node of nodes) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
    }
    return getComputedStyle(editor).backgroundColor;
  });
}

async function waitForMonacoBackground(page, expectedHex) {
  await waitUntil(
    `Monaco background → ${expectedHex}`,
    async () => {
      const css = await readMonacoBackground(page);
      if (css === null) return null;
      return cssColorToHex(css) === expectedHex.toLowerCase() ? css : null;
    },
    { timeout: 8000 },
  ).catch(() => {});
  const css = await readMonacoBackground(page);
  return css === null ? null : cssColorToHex(css);
}

/** Does a computed `background-color` actually fill anything? */
function isFilled(css) {
  return css !== null && css !== "rgba(0, 0, 0, 0)" && css !== "transparent";
}

/**
 * What the Document Mode surface actually paints.
 *
 * The editor's own background is expected to fill NOTHING — Document Mode
 * aliases `--vscode-editor-background` to `transparent` so the hosting column
 * shows through — so the raw strings come back and the caller judges them: a
 * bare truthiness read cannot tell "correctly transparent" from "no editor".
 * Both layers Monaco could fill are reported, plus the rendered ink and the app
 * token it must equal.
 */
async function readDocumentSurface(page) {
  return page.evaluate(() => {
    const editor = document.querySelector(".volli-document-mode .monaco-editor");
    if (editor === null) return null;
    const lines = editor.querySelector(".monaco-editor-background");
    const glyph = editor.querySelector(".view-line span") ?? editor.querySelector(".view-line");
    return {
      editorBackground: getComputedStyle(editor).backgroundColor,
      linesBackground: lines === null ? null : getComputedStyle(lines).backgroundColor,
      ink: glyph === null ? null : getComputedStyle(glyph).color,
      foregroundToken: getComputedStyle(document.documentElement)
        .getPropertyValue("--foreground")
        .trim(),
    };
  });
}

async function openSeededFile(page) {
  await goToNav(page, "Files", filesSettled(page));
  await waitUntil(
    "files empty or tree",
    async () =>
      (await page.locator('[data-testid="files-empty-state"]').count()) === 1 ||
      (await treeDir(page, "src").count()) === 1,
  );
  await expandDir(page, "src", APP_TS);
  await treeFile(page, APP_TS).click();
  return waitForMonacoReady(page, "theme probe");
}

async function openSeededDocument(page) {
  await goToNav(page, "Files", filesSettled(page));
  await waitUntil(
    `tree row for ${NOTES_MD}`,
    async () => (await treeFile(page, NOTES_MD).count()) === 1,
  );
  await treeFile(page, NOTES_MD).click();
  return waitForMonacoReady(page, "Document probe");
}

console.log("scratch:", scratch, "\n");

const projectDir = await makeGitRepo(scratch, "project-");
await fs.mkdir(join(projectDir, "src"), { recursive: true });
await fs.writeFile(join(projectDir, APP_TS), APP_TS_CONTENT, "utf8");
await fs.writeFile(join(projectDir, NOTES_MD), NOTES_MD_CONTENT, "utf8");
await execFileAsync("git", ["add", "-A"], { cwd: projectDir });
await execFileAsync("git", ["commit", "-q", "-m", "seed"], { cwd: projectDir });

const app = await launch({ dbPath, userDataDir });

try {
  await assertProfileIsolated(app, userDataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await sleep(1000);

  await seedProjects(page, [
    { id: PROJECT_SEED_ID, name: PROJECT_NAME, path: projectDir, prefix: TICKET_PREFIX },
  ]);

  await attempt(1, "project file opens a real Monaco editor (ready, no fallback)", async () => {
    const monaco = await openSeededFile(page);
    return {
      ok: monaco.status === "ready" && monaco.fallbacks === 0 && monaco.hasEditor,
      detail: `status=${monaco.status} fallbacks=${monaco.fallbacks} hosts=${monaco.hostCount}`,
    };
  });

  await attempt(2, "an unset editor theme paints the shipped One Dark Pro background", async () => {
    const state = await page.evaluate(async () => {
      const result = await window.api.theme.state({});
      return result.ok ? result.value.editorThemeId : null;
    });
    const bg = await waitForMonacoBackground(page, ONE_DARK_PRO_BG);
    return {
      ok: state === null && bg === ONE_DARK_PRO_BG,
      detail: `editorThemeId=${JSON.stringify(state)} bg=${bg} expected=${ONE_DARK_PRO_BG}`,
    };
  });

  await attempt(3, "Appearance Editor theme commit persists Nord", async () => {
    await openAppearanceSettings(page);
    await editorThemeTrigger(page).click();
    await page.getByRole("combobox", { name: "Search editor themes" }).fill("Nord");
    await page
      .getByRole("option", { name: /^Nord$/ })
      .first()
      .click();

    const label = await waitUntil("Editor theme trigger shows Nord", async () => {
      const text = (await editorThemeTrigger(page).textContent())?.trim();
      return text === "Nord" ? text : null;
    });

    const persisted = await waitUntil("theme.state editorThemeId=nord", async () => {
      const result = await page.evaluate(async () => window.api.theme.state({}));
      return result.ok && result.value.editorThemeId === "nord" ? "nord" : null;
    });

    return {
      ok: label === "Nord" && persisted === "nord",
      detail: `label=${JSON.stringify(label)} persisted=${persisted}`,
    };
  });

  await attempt(4, "returning to Files paints Monaco with Nord background", async () => {
    const monaco = await openSeededFile(page);
    const bg = await waitForMonacoBackground(page, NORD_BG);
    return {
      ok: monaco.status === "ready" && bg === NORD_BG,
      detail: `status=${monaco.status} bg=${bg} expected=${NORD_BG}`,
    };
  });

  await attempt(5, "catalog theme path never resurrects volli-dark", async () => {
    const probe = await page.evaluate(async () => {
      const result = await window.api.theme.state({});
      const id = result.ok ? result.value.editorThemeId : null;
      const editor = document.querySelector("[data-monaco-status] .monaco-editor");
      return {
        editorThemeId: id,
        monacoClass: editor?.className ?? null,
        mentionsVolliDark: (editor?.className ?? "").includes("volli-dark"),
      };
    });
    return {
      ok: probe.editorThemeId === "nord" && probe.mentionsVolliDark === false,
      detail: JSON.stringify(probe),
    };
  });

  await attempt(
    6,
    "a markdown document ignores the catalog theme and wears app tokens",
    async () => {
      // Still on the committed Nord, deliberately: passing here under the SHIPPED
      // default would only prove the two happened to agree.
      const monaco = await openSeededDocument(page);
      const surface = await readDocumentSurface(page);
      if (surface === null) return { ok: false, detail: "no Document Mode editor mounted" };
      const ink = cssColorToHex(surface.ink ?? "");
      return {
        ok:
          monaco.status === "ready" &&
          !isFilled(surface.editorBackground) &&
          !isFilled(surface.linesBackground) &&
          ink === cssColorToHex(surface.foregroundToken),
        detail: `status=${monaco.status} ${JSON.stringify(surface)} ink=${ink}`,
      };
    },
  );
} catch (error) {
  check("!", "smoke crashed", false, String(error?.stack ?? error));
} finally {
  await app.close().catch(() => {});
}

const exitCode = summarize();
await cleanup();
process.exit(exitCode);
