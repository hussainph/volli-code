/**
 * End-to-end acceptance smoke for the GLOBAL ARTIFACTS + @file refs rework
 * (CONCEPT decision #33, docs/plans/global-artifacts.md). Drives the REAL
 * packaged renderer through Playwright against a scratch SQLite database
 * (`VOLLI_DB_PATH`) + isolated user-data dir:
 *
 *   1. @-picker insert + chip — a pre-seeded `.volli/artifacts/probe.md` shows
 *      up in the ticket-body `@` autocomplete (typed `@probe`); picking it
 *      inserts the plain-text `@.volli/artifacts/probe.md` ref, which renders
 *      as a clickable chip (`.cm-file-chip`) once the caret leaves the token.
 *   2. Chip opens a file tab — clicking the chip opens a closable `file` tab
 *      labeled `probe.md` next to Doc, rendering the markdown in the SAME CM6
 *      live editor (`.cm-md-h1`).
 *   3. File-tab edit autosaves to disk — select-all + retype in the file tab,
 *      blur → the edit lands in `.volli/artifacts/probe.md` (mtime-guarded
 *      autosave, no Save button).
 *   4. Create-artifact via the picker — typing `@newnote` offers a
 *      `Create artifact "newnote.md"` row; picking it creates
 *      `.volli/artifacts/newnote.md` on disk (templated `# newnote`), inserts
 *      the @ref, opens its tab, and `.volli/.gitignore` is `*` (self-ignored).
 *   5. Repo-file ref opens an EDITABLE source editor — `@src/monaco-probe.ts`
 *      resolves in the picker and its tab shows the content in an explicit-save
 *      (⌘S) Monaco editor under `volli-app://bundle/`. A repository file is an
 *      editable document (CONCEPT #49: only images, binary and truncated reads
 *      stay read-only), so nothing here is read-only. The TypeScript language
 *      worker completes a real public-API handshake without a fallback warning.
 *      And the dead ticket tier is truly dead: `.volli/tickets/` was never
 *      created on disk.
 *   6. Tab persistence — relaunch against the SAME app-data dir: the detail
 *      reopens with the file tabs restored and the last-active file tab
 *      selected (persisted `ticketTabs` in workspace ui state).
 *
 * Every assertion polls (expect-style waits); no bare sleeps stand in for a
 * condition (the few fixed sleeps only pace UI settling, never assert).
 *
 * This is a MANUALLY-RUN smoke (needs a display + the built app); it is NOT
 * wired into `vp test`.
 *
 *   Run:
 *     pnpm run build                            # produce dist/ + dist-electron/
 *     node apps/desktop/e2e/global-artifacts-smoke.mjs
 *
 *   Requires: playwright-core (devDependency of @volli/desktop).
 *   Exit code is non-zero if any numbered check fails.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron } from "playwright-core";

// This probe predates smoke-kit and keeps its own launch/harness scaffolding,
// but the Monaco readers are shared: how THIS build is interrogated (input
// surface, read-only contract, rendered aria-label) is encoded once there, so a
// change to Monaco's input strategy is a one-file fix.
import { isMonacoEditable, readMonacoState } from "./lib/smoke-kit.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APP_DIR = join(REPO, "apps", "desktop");
const ELECTRON = join(
  APP_DIR,
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
  "Contents",
  "MacOS",
  "Electron",
);

const ownsScratch = process.env.VOLLI_SMOKE_DIR === undefined;
const SCRATCH =
  process.env.VOLLI_SMOKE_DIR ??
  (await fs.mkdtemp(join(os.tmpdir(), "volli-global-artifacts-smoke-")));
const USER_DATA_DIR = join(SCRATCH, "user-data");
const DB_PATH = join(SCRATCH, "volli.db");
await fs.mkdir(USER_DATA_DIR, { recursive: true });

// A real, writable project directory (realpath'd so the seeded path matches
// node's resolve() — macOS temp dirs can be symlinked). Not a git repo, so the
// file index exercises main's bounded-walk fallback path.
const PROJECT_DIR = await fs.realpath(await fs.mkdtemp(join(SCRATCH, "project-")));
const PROJECT_SEED_ID = "global-artifacts-project";
const TICKET_PREFIX = "VC";
const DISPLAY_ID = `${TICKET_PREFIX}-1`;

const VOLLI_DIR = join(PROJECT_DIR, ".volli");
const ARTIFACTS_DIR = join(VOLLI_DIR, "artifacts");
const GITIGNORE_PATH = join(VOLLI_DIR, ".gitignore");

// Pre-seeded before launch: one artifact (the @-ref target) and one plain repo
// file (the explicit-save Monaco path). Their basenames are the picker queries.
const ARTIFACT_NAME = "probe.md";
const ARTIFACT_REL = `.volli/artifacts/${ARTIFACT_NAME}`;
const ARTIFACT_MARKDOWN = "Probe intro line\n\n# Probe Artifact\n\nBody with `code`.\n";
const ARTIFACT_EDITED = "# Probe Edited\n\nRewritten through the file tab.\n";
const REPO_FILE_NAME = "monaco-probe.ts";
const REPO_FILE_REL = `src/${REPO_FILE_NAME}`;
const REPO_FILE_CONTENT = 'export const monacoProbe: string = "language worker ready";\n';
const CREATED_NAME = "newnote";
const CREATED_REL = `.volli/artifacts/${CREATED_NAME}.md`;

const BODY_INTRO = "Intro line";

// ---- tiny test harness -----------------------------------------------------

const results = [];
function check(n, label, ok, detail = "") {
  const status = ok ? "PASS" : "FAIL";
  results.push({ n, ok });
  console.log(`  [${status}] ${n}. ${label}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run one check's body; a thrown error fails that check without aborting the run. */
async function attempt(n, label, fn) {
  try {
    const { ok, detail } = await fn();
    check(n, label, ok, detail);
  } catch (error) {
    check(n, label, false, `threw: ${error?.message ?? error}`);
  }
}

/** Poll `fn` until truthy (returned) or timeout (throws with `label` + last state). */
async function waitUntil(label, fn, { timeout = 12000, interval = 150 } = {}) {
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

async function readFileSafe(path) {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function pathExists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

// ---- launch ----------------------------------------------------------------

function launch(dbPath) {
  return _electron.launch({
    executablePath: ELECTRON,
    args: [APP_DIR, `--user-data-dir=${USER_DATA_DIR}`],
    env: { ...process.env, VOLLI_DB_PATH: dbPath, VOLLI_SKIP_CLOSE_CONFIRM: "1" },
  });
}

// ---- DOM helpers -----------------------------------------------------------

function cardById(page, id) {
  const exact = new RegExp(`^${id}$`);
  return page
    .locator("article")
    .filter({ has: page.locator("span.font-mono", { hasText: exact }) });
}

function docTab(page) {
  return page.getByRole("tab", { name: DISPLAY_ID, exact: true });
}

function fileTab(page, basename) {
  return page.getByRole("tab", { name: basename, exact: true });
}

async function detailOpen(page) {
  return (await docTab(page).count()) === 1;
}

async function boardOpen(page) {
  return (await cardById(page, DISPLAY_ID).count()) === 1 && !(await detailOpen(page));
}

async function openTicketViaCard(page) {
  for (let attemptN = 0; attemptN < 3; attemptN++) {
    await cardById(page, DISPLAY_ID).dblclick();
    try {
      await waitUntil("detail view to open", () => detailOpen(page), { timeout: 4000 });
      return;
    } catch {
      // fall through and retry
    }
  }
  throw new Error("detail view never opened after double-click");
}

/**
 * Type an `@` query into the focused body editor and click the completion row
 * whose `.cm-completionLabel` matches `label` exactly. Returns once the popup
 * has closed (the pick applied).
 */
async function pickCompletion(page, query, label) {
  await page.keyboard.type(query);
  const tooltip = page.locator(".cm-tooltip-autocomplete");
  await waitUntil(`completion popup for ${query}`, async () => (await tooltip.count()) === 1, {
    timeout: 8000,
  });
  const option = tooltip.locator(".cm-completionLabel", { hasText: label }).first();
  await waitUntil(
    `completion option ${JSON.stringify(label)}`,
    async () => (await option.count()) >= 1,
  );
  await option.click();
  await waitUntil("completion popup to close", async () => (await tooltip.count()) === 0, {
    timeout: 8000,
  });
}

/** Park the caret on the doc's first line so any @-token chip collapses (caret-off reveal rule). */
async function parkCaretOnFirstLine(page) {
  await page.locator(".cm-content .cm-line").first().click();
}

// ---- main ------------------------------------------------------------------

async function main() {
  // Seed the on-disk project BEFORE launch: one artifact + one plain repo file.
  await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
  await fs.writeFile(join(ARTIFACTS_DIR, ARTIFACT_NAME), ARTIFACT_MARKDOWN, "utf8");
  await fs.mkdir(join(PROJECT_DIR, "src"), { recursive: true });
  await fs.writeFile(join(PROJECT_DIR, "src", REPO_FILE_NAME), REPO_FILE_CONTENT, "utf8");

  let app = await launch(DB_PATH);

  try {
    // Profile isolation guard: a leaked default profile would corrupt real data.
    const actualUserDataDir = await app.evaluate(({ app: electronApp }) =>
      electronApp.getPath("userData"),
    );
    const [actual, expected] = await Promise.all([
      fs.realpath(actualUserDataDir),
      fs.realpath(USER_DATA_DIR),
    ]);
    if (actual !== expected) {
      throw new Error(`smoke profile is not isolated: expected ${expected}, got ${actual}`);
    }

    let page = await app.firstWindow();
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
      if (/monaco|worker/i.test(error.message)) {
        monacoRuntimeFailures.push(`pageerror: ${error.message}`);
      }
    });
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    // ---- seed: import one project (temp dir) then create one ticket --------
    await page.evaluate(
      ({ id, path, prefix }) => {
        localStorage.setItem(
          "volli:projects",
          JSON.stringify({
            state: {
              projects: [
                {
                  id,
                  name: "Global Artifacts Project",
                  path,
                  ticketPrefix: prefix,
                  colorIndex: 0,
                  createdAt: Date.now(),
                },
              ],
              selectedProjectId: id,
            },
            version: 1,
          }),
        );
      },
      { id: PROJECT_SEED_ID, path: PROJECT_DIR, prefix: TICKET_PREFIX },
    );
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1200);

    const seed = await page.evaluate(async (title) => {
      const boot = await window.api.data.bootstrap();
      if (!boot.ok) return { ok: false, error: `bootstrap: ${boot.error}` };
      const project = boot.data.projects[0];
      if (!project) return { ok: false, error: "no project after import" };
      const res = await window.api.tickets.create({
        projectId: project.id,
        status: "todo",
        title,
        priority: "medium",
      });
      if (!res.ok) return { ok: false, error: `create: ${res.error}` };
      return { ok: true, projectId: project.id, ticketId: res.ticket.id };
    }, "Global artifacts probe ticket");
    if (!seed.ok) throw new Error(`seed failed: ${seed.error}`);
    const TICKET_ID = seed.ticketId;

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await waitUntil("seeded card to render", () => boardOpen(page));
    await openTicketViaCard(page);

    // ===================================================================
    // 1. @-PICKER INSERT + CHIP (pre-seeded artifact resolves)
    // ===================================================================
    await attempt(
      1,
      "@-picker: typing @probe offers the seeded artifact; picking inserts the plain-text ref which chips once the caret leaves",
      async () => {
        // Type an intro line first so the chip's line isn't the caret's
        // post-insert line-start reveal target.
        await page.locator(".cm-content").click();
        await page.keyboard.type(BODY_INTRO);
        await page.keyboard.press("Enter");
        await page.keyboard.press("Enter");
        await page.keyboard.type("See ");

        await pickCompletion(page, `@${ARTIFACT_NAME.slice(0, 5)}`, ARTIFACT_NAME);

        // The inserted form is the raw path token (revealed while the caret
        // touches it) — assert the buffer holds the plain-text ref.
        const rawInserted = await waitUntil("raw @ref in buffer", async () => {
          const text = await page.locator(".cm-content").innerText();
          return text.includes(`@${ARTIFACT_REL}`) ? true : null;
        });

        // Move the caret off the token → the chip decoration replaces it.
        await parkCaretOnFirstLine(page);
        const chip = page.locator(`.cm-file-chip[data-file-ref="${ARTIFACT_REL}"]`);
        const chipShown = await waitUntil(
          "file chip to render",
          async () => (await chip.count()) === 1,
        );
        const chipLabel = (await chip.textContent())?.includes(ARTIFACT_NAME);

        const ok = !!rawInserted && !!chipShown && !!chipLabel;
        return { ok, detail: `raw=${!!rawInserted} chip=${!!chipShown} label=${!!chipLabel}` };
      },
    );

    // ===================================================================
    // 2. CHIP OPENS A FILE TAB (markdown in the live editor)
    // ===================================================================
    await attempt(
      2,
      "Chip click opens a closable file tab (probe.md) rendering markdown in the live editor",
      async () => {
        await page.locator(`.cm-file-chip[data-file-ref="${ARTIFACT_REL}"]`).click();
        const tab = fileTab(page, ARTIFACT_NAME);
        await waitUntil("file tab to appear", async () => (await tab.count()) === 1);
        const active = await waitUntil(
          "file tab active",
          async () => (await tab.getAttribute("aria-selected")) === "true",
        );
        // The seeded markdown renders in the same CM6 live-preview editor.
        const rendered = await waitUntil("artifact markdown render", async () => {
          const h1 = (await page.locator(".cm-md-h1").count()) >= 1;
          const code = (await page.locator(".cm-md-code").count()) >= 1;
          return h1 && code;
        });
        // File tabs are closable (the × affordance session tabs have).
        const closable =
          (await page.getByRole("button", { name: `Close ${ARTIFACT_NAME}` }).count()) === 1;

        const ok = !!active && !!rendered && closable;
        return { ok, detail: `active=${!!active} rendered=${!!rendered} closable=${closable}` };
      },
    );

    // ===================================================================
    // 3. FILE-TAB EDIT AUTOSAVES TO DISK (no Save button)
    // ===================================================================
    await attempt(
      3,
      "File-tab edit: select-all + retype autosaves to .volli/artifacts/probe.md on blur (no Save button)",
      async () => {
        const noSaveButton =
          (await page.getByRole("button", { name: "Save", exact: true }).count()) === 0;
        await page.locator(".cm-content").click();
        await page.keyboard.press("Meta+a");
        await page.keyboard.type(ARTIFACT_EDITED);
        // Blur onto the Doc tab to flush the debounced autosave.
        await docTab(page).click();
        const saved = await waitUntil("edited artifact on disk", async () => {
          const text = await readFileSafe(join(ARTIFACTS_DIR, ARTIFACT_NAME));
          return text === ARTIFACT_EDITED ? text : null;
        });
        const ok = noSaveButton && saved === ARTIFACT_EDITED;
        return { ok, detail: `noSave=${noSaveButton} saved=${saved === ARTIFACT_EDITED}` };
      },
    );

    // ===================================================================
    // 4. CREATE ARTIFACT VIA THE PICKER (+ self-gitignore)
    // ===================================================================
    await attempt(
      4,
      "Create via picker: @newnote offers 'Create artifact', creating the templated .md on disk, inserting the ref, opening its tab; .volli/.gitignore is *",
      async () => {
        // Back on the Doc tab (blur landed there); append on a fresh line.
        await page.locator(".cm-content").click();
        await page.keyboard.press("Meta+ArrowDown");
        await page.keyboard.press("Enter");
        await pickCompletion(page, `@${CREATED_NAME}`, `Create artifact "${CREATED_NAME}.md"`);

        const onDisk = await waitUntil("created artifact on disk", () =>
          readFileSafe(join(PROJECT_DIR, CREATED_REL)),
        );
        const templated = onDisk?.startsWith(`# ${CREATED_NAME}`);
        const tab = fileTab(page, `${CREATED_NAME}.md`);
        const tabOpened = await waitUntil(
          "created artifact tab active",
          async () => (await tab.getAttribute("aria-selected")) === "true",
        );
        const gitignore = await readFileSafe(GITIGNORE_PATH);

        // The inserted @ref reaches the persisted ticket body (autosave).
        await docTab(page).click();
        const refPersisted = await waitUntil("created @ref in SQLite body", async () => {
          const body = await page.evaluate(async (id) => {
            const boot = await window.api.data.bootstrap();
            if (!boot.ok) return null;
            for (const list of Object.values(boot.data.ticketsByProject ?? {})) {
              const found = list.find((t) => t.id === id);
              if (found) return found.body ?? "";
            }
            return null;
          }, TICKET_ID);
          return body !== null && body.includes(`@${CREATED_REL}`) ? true : null;
        });

        const ok = !!templated && !!tabOpened && gitignore === "*\n" && !!refPersisted;
        return {
          ok,
          detail: `templated=${!!templated} tab=${!!tabOpened} gitignore=${JSON.stringify(gitignore)} refPersisted=${!!refPersisted}`,
        };
      },
    );

    // ===================================================================
    // 5. REPO FILE OPENS EDITABLE IN MONACO + LANGUAGE WORKER + APP ORIGIN
    // ===================================================================
    await attempt(
      5,
      "Repo-file ref opens an EDITABLE (explicit-save) Monaco TypeScript model under the app origin, completes a real language-worker handshake, and never creates .volli/tickets/",
      async () => {
        await page.locator(".cm-content").click();
        await page.keyboard.press("Meta+ArrowDown");
        await page.keyboard.press("Enter");
        await pickCompletion(page, `@${REPO_FILE_NAME.slice(0, 5)}`, REPO_FILE_NAME);
        await parkCaretOnFirstLine(page);

        const chip = page.locator(`.cm-file-chip[data-file-ref="${REPO_FILE_REL}"]`);
        await waitUntil("repo-file chip", async () => (await chip.count()) === 1);
        await chip.click();

        const tab = fileTab(page, REPO_FILE_NAME);
        await waitUntil(
          "repo-file tab active",
          async () => (await tab.getAttribute("aria-selected")) === "true",
        );
        const monacoReady = await waitUntil(
          "editable Monaco editor with worker",
          async () => {
            const el = await readMonacoState(page);
            // CONCEPT #49: a repository .ts file is an explicit-save EDITABLE
            // document, so `isMonacoEditable` must hold — our own read-only
            // contract attribute AND Monaco's rendered accessible name, both
            // checked in smoke-kit so neither copy can drift.
            if (
              el.status === "ready" &&
              el.language === "typescript" &&
              el.worker === "ready" &&
              isMonacoEditable(el) &&
              el.hasEditor &&
              el.text.includes("monacoProbe")
            ) {
              return el;
            }
            throw new Error(
              `state=${JSON.stringify({ ...el, text: el.text.slice(0, 120), lines: undefined })} runtimeFailures=${JSON.stringify(monacoRuntimeFailures)}`,
            );
          },
          { timeout: 20000 },
        );

        const appOrigin = page.url().startsWith("volli-app://bundle/index.html");
        const noTicketTier = !(await pathExists(join(VOLLI_DIR, "tickets")));
        const noFallback = monacoRuntimeFailures.length === 0;

        const ok = !!monacoReady && appOrigin && noFallback && noTicketTier;
        return {
          ok,
          detail: `monaco=${!!monacoReady} editable=${JSON.stringify(monacoReady?.editorAriaLabel ?? null)} origin=${appOrigin} worker=${monacoReady?.worker ?? "missing"} noFallback=${noFallback} noTicketTier=${noTicketTier}${noFallback ? "" : ` failures=${JSON.stringify(monacoRuntimeFailures)}`}`,
        };
      },
    );

    // ===================================================================
    // 6. TAB PERSISTENCE ACROSS RESTART
    // ===================================================================
    // Make probe.md the active tab, then wait for the workspace persist write.
    await fileTab(page, ARTIFACT_NAME).click();
    await waitUntil("ticketTabs to persist to app_state", async () => {
      const raw = await page.evaluate(async () => {
        const res = await window.api.data.bootstrap();
        if (!res.ok) return null;
        return res.data.appState["volli:workspace"] ?? null;
      });
      return typeof raw === "string" && raw.includes(`file:${ARTIFACT_REL}`);
    });

    await app.close();
    app = await launch(DB_PATH);
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    await attempt(
      6,
      "Restart: detail reopens with all three file tabs restored and probe.md still the active tab (persisted ticketTabs)",
      async () => {
        await waitUntil("detail view to reopen after relaunch", () => detailOpen(page), {
          timeout: 20000,
        });
        const probeTab = fileTab(page, ARTIFACT_NAME);
        const tabsRestored = await waitUntil("file tabs restored", async () => {
          const probe = (await probeTab.count()) === 1;
          const created = (await fileTab(page, `${CREATED_NAME}.md`).count()) === 1;
          const repo = (await fileTab(page, REPO_FILE_NAME).count()) === 1;
          return probe && created && repo;
        });
        const activeRestored = await waitUntil(
          "probe.md active after restart",
          async () => (await probeTab.getAttribute("aria-selected")) === "true",
        );
        // The restored active tab renders its (edited) markdown.
        const contentRestored = await waitUntil("restored tab renders content", async () => {
          return (await page.locator(".cm-md-h1").count()) >= 1;
        });

        const ok = !!tabsRestored && !!activeRestored && !!contentRestored;
        return {
          ok,
          detail: `tabs=${!!tabsRestored} active=${!!activeRestored} content=${!!contentRestored}`,
        };
      },
    );
  } finally {
    await app.close();
  }

  const failures = results.filter((r) => !r.ok);
  console.log(
    `\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} CHECK(S) FAILED: ${failures.map((f) => f.n).join(", ")}`}`,
  );
  return failures.length === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error("\nSMOKE ABORTED:", error?.stack ?? error);
  code = 1;
} finally {
  if (ownsScratch) await fs.rm(SCRATCH, { recursive: true, force: true });
}
process.exit(code);
