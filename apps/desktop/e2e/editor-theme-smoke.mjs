/**
 * End-to-end smoke for Monaco editor theming (issue #122, VC-123).
 *
 * Drives the REAL packaged app through Playwright against an isolated profile
 * and a seeded git repo. Proves what unit tests cannot see:
 *
 *   1. Opening a project file boots a real Monaco editor (ready, no fallback).
 *   2. In a DARK app, Monaco paints the shipped dark theme's background.
 *   3. Flipping the app to LIGHT repaints Monaco with the light theme — no
 *      picker, no reload, no editor write. This is the whole ticket: the pair
 *      follows the one appearance choice the app already has.
 *   4. Flipping back to dark restores the dark theme, so the follow is a live
 *      binding rather than a one-way boot-time read.
 *   5. The editor's FURNITURE comes from app tokens, not from the shiki theme:
 *      Monaco's background equals the app's own `--background` in light mode
 *      (source-mode.css), which is what makes the editor part of the surface.
 *   6. Source Mode and Document Mode still part ways: a ticket body paints NO
 *      catalog background and takes its ink from `--foreground`
 *      (document-mode.css) — the split nothing but a real window can see.
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
  cardById,
  createRunner,
  goToBoard,
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

/**
 * The two shipped themes' `editor.background`, read out of `@shikijs/themes`
 * and pinned here as literals — independent of the app, so a regression in
 * which theme is chosen cannot rewrite the expectation with it.
 *
 * Only asserted where source-mode.css does NOT override the ground: it aliases
 * `--vscode-editor-background` to the app canvas, so what Monaco actually
 * paints is the app's background. The theme pins stay as the reference for
 * what would be on screen without that alias.
 */
const VITESSE_LIGHT_BG = "#ffffff";
const VITESSE_DARK_BG = "#121212";

const PROJECT_SEED_ID = "editor-theme-project";
const PROJECT_NAME = "Editor Theme Project";
const TICKET_PREFIX = "ET";
const APP_TS = "src/app.ts";
const APP_TS_CONTENT = 'export const app = "theme probe";\n';
/**
 * The Document Mode surface is reached through a ticket body, not through a
 * markdown file in the workbench: repository markdown takes the explicit-⌘S
 * Source Mode contract, and only a Markdown Artifact autosaves (`fileSavePolicy`).
 * The ticket body is also the surface the theming bug was reported against.
 */
const TICKET_TITLE = "Document surface probe";
const TICKET_BODY = "Prose on the page.";
const DISPLAY_ID = `${TICKET_PREFIX}-1`;

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

/**
 * Set the app-wide appearance through the same IPC the Mode control writes,
 * then wait for the renderer to finish repainting.
 *
 * Driven over `window.api` rather than by clicking Settings → Mode because the
 * assertion is about MONACO, not about the button: routing through the store's
 * own write path proves the editor follows the committed appearance, and keeps
 * this check from failing the day that control is restyled.
 */
async function setAppearance(page, appearance) {
  const ok = await page.evaluate(async (mode) => {
    const result = await window.api.theme.setGlobalAppearance(mode);
    return result.ok;
  }, appearance);
  if (!ok) throw new Error(`setGlobalAppearance(${appearance}) failed`);
  await waitUntil(
    `<html> to wear the ${appearance} class`,
    async () =>
      (await page.evaluate(
        (mode) =>
          mode === "light"
            ? document.documentElement.classList.contains("light")
            : !document.documentElement.classList.contains("light"),
        appearance,
      )) || null,
  );
}

/** The app's own `--background`, as the canvas system resolved it right now. */
async function readAppBackground(page) {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
  );
}

async function goToNav(page, label, settled) {
  await navButton(page, label).click();
  await waitUntil(`${label} page to settle`, () => settled(), { timeout: 15000 });
}

const filesSettled = (page) => async () =>
  (await page.locator('[data-testid="files-workbench"]').count()) === 1;

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

/** Open the seeded ticket's detail; its Doc tab body is an always-mounted Document Mode editor. */
async function openTicketDocument(page) {
  await goToBoard(page);
  for (let attemptN = 0; attemptN < 3; attemptN += 1) {
    await cardById(page, DISPLAY_ID).dblclick();
    const opened = await waitUntil(
      "ticket body editor to mount",
      async () => (await readDocumentSurface(page))?.ink ?? null,
      { timeout: 8000 },
    )
      .then(() => true)
      .catch(() => false);
    if (opened) return;
  }
  throw new Error("ticket detail never mounted a Document Mode editor");
}

console.log("scratch:", scratch, "\n");

const projectDir = await makeGitRepo(scratch, "project-");
await fs.mkdir(join(projectDir, "src"), { recursive: true });
await fs.writeFile(join(projectDir, APP_TS), APP_TS_CONTENT, "utf8");
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

  // One ticket, seeded up front so the Document Mode surface (check 6) is a
  // board double-click away. Reload afterwards: the board store hydrates from
  // SQLite at boot and would not otherwise know about a ticket created here.
  const seeded = await page.evaluate(
    async ({ title, body }) => {
      const boot = await window.api.data.bootstrap();
      if (!boot.ok) return { ok: false, error: `bootstrap: ${boot.error}` };
      const project = boot.data.projects[0];
      if (!project) return { ok: false, error: "no project after seeding" };
      const created = await window.api.tickets.create({
        projectId: project.id,
        status: "todo",
        title,
        body,
        priority: "medium",
      });
      return created.ok
        ? { ok: true, ticketId: created.ticket.id }
        : { ok: false, error: `create: ${created.error}` };
    },
    { title: TICKET_TITLE, body: TICKET_BODY },
  );
  if (!seeded.ok) throw new Error(`ticket seed failed: ${seeded.error}`);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await waitUntil(
    "seeded card to render",
    async () => (await cardById(page, DISPLAY_ID).count()) === 1,
  );

  await attempt(1, "project file opens a real Monaco editor (ready, no fallback)", async () => {
    const monaco = await openSeededFile(page);
    return {
      ok: monaco.status === "ready" && monaco.fallbacks === 0 && monaco.hasEditor,
      detail: `status=${monaco.status} fallbacks=${monaco.fallbacks} hosts=${monaco.hostCount}`,
    };
  });

  await attempt(2, "a dark app paints Monaco with the shipped dark theme", async () => {
    await setAppearance(page, "dark");
    await openSeededFile(page);
    const bg = await waitForMonacoBackground(page, VITESSE_DARK_BG);
    // Nothing about the editor is persisted any more — the appearance row is
    // the only thing that decided this.
    const payload = await page.evaluate(async () => {
      const result = await window.api.theme.state({});
      return result.ok ? Object.keys(result.value) : null;
    });
    return {
      ok: bg === VITESSE_DARK_BG && payload !== null && !payload.includes("editorThemeId"),
      detail: `bg=${bg} expected=${VITESSE_DARK_BG} stateKeys=${JSON.stringify(payload)}`,
    };
  });

  await attempt(3, "flipping the app to light repaints Monaco light, with no reload", async () => {
    // The ticket, in one check: no picker was touched and nothing remounted.
    await setAppearance(page, "light");
    const bg = await waitForMonacoBackground(page, VITESSE_LIGHT_BG);
    const state = await readMonacoState(page);
    return {
      ok: bg === VITESSE_LIGHT_BG && state.status === "ready" && state.fallbacks === 0,
      detail: `bg=${bg} expected=${VITESSE_LIGHT_BG} status=${state.status} fallbacks=${state.fallbacks}`,
    };
  });

  await attempt(4, "flipping back to dark restores the dark theme", async () => {
    // Proves the pairing is a live binding, not a boot-time read.
    await setAppearance(page, "dark");
    const bg = await waitForMonacoBackground(page, VITESSE_DARK_BG);
    return {
      ok: bg === VITESSE_DARK_BG,
      detail: `bg=${bg} expected=${VITESSE_DARK_BG}`,
    };
  });

  await attempt(5, "the editor's ground is the app's own token, not the theme's", async () => {
    // source-mode.css aliases `--vscode-editor-background` to `--background`,
    // so in LIGHT the editor must match the app canvas rather than the shiki
    // theme's flat white. Checked in light because that is where a mismatch
    // between the two is visible at all.
    await setAppearance(page, "light");
    await openSeededFile(page);
    const appBg = await readAppBackground(page);
    const painted = await waitForMonacoBackground(page, cssColorToHex(appBg));
    const editorClass = await page.evaluate(
      () => document.querySelector("[data-monaco-status] .volli-source-mode") !== null,
    );
    return {
      ok: painted === cssColorToHex(appBg) && editorClass,
      detail: `painted=${painted} --background=${appBg} sourceModeHost=${editorClass}`,
    };
  });

  await attempt(6, "a ticket body stays transparent while a file view is grounded", async () => {
    // Run in LIGHT, deliberately. Document Mode is transparent in both modes,
    // so under dark this would pass even if the split had collapsed — light is
    // where "no ground of its own" and "the app's ground" look different.
    await openTicketDocument(page);
    const surface = await readDocumentSurface(page);
    if (surface === null) return { ok: false, detail: "no Document Mode editor mounted" };
    const ink = cssColorToHex(surface.ink ?? "");
    return {
      ok:
        !isFilled(surface.editorBackground) &&
        !isFilled(surface.linesBackground) &&
        ink === cssColorToHex(surface.foregroundToken),
      detail: `${JSON.stringify(surface)} ink=${ink}`,
    };
  });
} catch (error) {
  check("!", "smoke crashed", false, String(error?.stack ?? error));
} finally {
  await app.close().catch(() => {});
}

const exitCode = summarize();
await cleanup();
process.exit(exitCode);
