/**
 * End-to-end acceptance smoke for Volli's ticket-detail view, reconciled with
 * the ROUND-2 UX (docs/plans/ticket-detail-mvp.md §29–39). Drives the REAL
 * packaged renderer through Playwright against a scratch SQLite database
 * (`VOLLI_DB_PATH`) + isolated user-data dir, exercising the reworked surface:
 *
 *   1. Open/close   — double-click a card opens the detail; the top is a full-
 *      width Chrome-style tab strip whose Doc tab is labeled with the display id
 *      (e.g. "VC-1"); there is NO breadcrumb and NO Artifacts tab (the global-
 *      artifacts rework, CONCEPT #33 — `@file` refs are covered by
 *      global-artifacts-smoke.mjs). Escape returns to the board; re-open works;
 *      clicking the already-active Board nav item also exits the detail instead
 *      of leaving the ticket stranded open.
 *   2. Title edit   — click-to-edit the heading, Enter commits + renders, and
 *      the board card shows the new title after Escape-back.
 *   3. Body editor  — an always-mounted CodeMirror 6 live-preview editor
 *      (`.cm-editor`/contenteditable `.cm-content`, no textarea, no click-to-edit
 *      flip). Typed markdown renders in place (`.cm-md-h1` with the `#` hidden
 *      off-line, `.cm-md-code`); the `#` REVEALS when the caret lands on the
 *      heading line; edits autosave (debounce + blur-flush) to SQLite.
 *   4. Activity     — consecutive events BUNCH into one row fronted by the
 *      highest-signal event ("created the ticket") with a "+N more" caret BEFORE
 *      the timestamp; expanding reveals the indented `renamed to "…"` one-liner.
 *      Comments still post (⌘↵) as "You", edit inline, and delete via confirm.
 *   5. Ticket session — the rail's "New session" boots a ticket-scoped PTY; env
 *      injection is proven with the file-probe pattern ($VOLLI_TICKET == display
 *      id, $VOLLI_ARTIFACTS_DIR == the project's `.volli/artifacts` path — the
 *      global-artifacts env contract; VOLLI_TICKET_DIR is gone); switching
 *      Doc ↔ session keeps the terminal alive; the rail shows a chip and the
 *      truthful Shell source label (never the default Claude harness).
 *   6. Resident keep-alive — navigating ticket → board → ticket keeps the SAME
 *      terminal canvas DOM node mounted (marked node survives) and the shell
 *      alive (the overlay hosts terminals, the detail is only a view over it).
 *   7. Session rename — double-click the session tab, type, Enter; the new title
 *      shows on both the tab and the rail row.
 *   8. Rail + Details — the right rail is sessions-first with a collapsed-by-
 *      default "Details" drawer holding status/priority/labels; NO harness row
 *      anywhere, and the board filter bar has NO Harness chip.
 *   9. Nav history — the chrome bar's ←/→ buttons (and ⌘[ / ⌘]) traverse
 *      ticket open/close snapshots.
 *  10. Rail toggle — the chrome bar's mirrored rail button and ⌥⌘B hide/show the
 *      rail; the collapsed state persists (checked at restart).
 *  11. Restart      — relaunch against the SAME app-data dir: the ticket detail
 *      reopens (persisted openTicketId), the edited title/body + surviving
 *      comment are intact, the rail is STILL collapsed (persisted), and the
 *      renamed session is tucked into the collapsed History drawer, then remains
 *      findable when expanded with its Shell + ended-ago metadata. Back returns to
 *      the board even though the in-memory nav history starts fresh.
 *
 * The terminal is a WebGPU/WebGL2 canvas — its text is NOT in the DOM — so shell
 * behaviour is asserted through SIDE EFFECTS (keystrokes → a file the shell
 * writes, then polled). Every assertion polls (expect-style waits); there are no
 * bare sleeps standing in for a condition.
 *
 * This is a MANUALLY-RUN smoke (needs a display + the built app); it is NOT
 * wired into `vp test`.
 *
 *   Run:
 *     pnpm run build                            # produce dist/ + dist-electron/
 *     node apps/desktop/e2e/ticket-detail-smoke.mjs
 *
 *   Requires: playwright-core (devDependency of @volli/desktop).
 *   Exit code is non-zero if any numbered check fails.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron } from "playwright-core";

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
  (await fs.mkdtemp(join(os.tmpdir(), "volli-ticket-detail-smoke-")));
const USER_DATA_DIR = join(SCRATCH, "user-data");
const DB_PATH = join(SCRATCH, "volli.db");
await fs.mkdir(USER_DATA_DIR, { recursive: true });

// A real, writable project directory (realpath'd so the seeded path matches the
// shell's $PWD and node's resolve() — macOS temp dirs can be symlinked). This is
// where the app writes `.volli/`; a temp dir keeps the smoke from polluting the
// repo the way pointing it at REPO would.
const PROJECT_DIR = await fs.realpath(await fs.mkdtemp(join(SCRATCH, "project-")));
const PROJECT_SEED_ID = "ticket-detail-project";
const TICKET_PREFIX = "VC";
const DISPLAY_ID = `${TICKET_PREFIX}-1`;

// What main injects as VOLLI_ARTIFACTS_DIR (projectArtifactsDir(projectPath) —
// the global-artifacts env contract; there is no per-ticket dir anymore).
const VOLLI_DIR = join(PROJECT_DIR, ".volli");
const EXPECTED_ARTIFACTS_DIR = join(VOLLI_DIR, "artifacts");

const PROBE_ENV = join(SCRATCH, "probe-env.txt");
const PROBE_ALIVE = join(SCRATCH, "probe-alive.txt");
const PROBE_NAV = join(SCRATCH, "probe-nav.txt");

const INITIAL_TITLE = "Original ticket title";
const RENAMED_TITLE = "Renamed ticket title";
// Typed into the live-preview editor. Line 0 is a plain paragraph so the heading
// on line 2 renders with its `#` hidden even with the caret parked at offset 0
// (an unfocused CM editor's default selection sits at the doc start).
const BODY_INTRO = "Intro line";
const BODY_HEADING = "Hello World";
const BODY_CODE = "text `code` here";
const EXPECTED_BODY = `${BODY_INTRO}\n\n# ${BODY_HEADING}\n\n${BODY_CODE}`;

const COMMENT_ONE = "First work log note";
const COMMENT_ONE_EDITED = "Edited work log note";
const COMMENT_TWO = "Second note to delete";
const SESSION_INITIAL = "Session 1";
const SESSION_RENAMED = "Renamed session";

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

/**
 * Poll `fn` until it returns a truthy value (returned to the caller) or the
 * timeout elapses (throws with `label` + the last value/error). The one waiting
 * primitive the whole suite uses instead of fixed sleeps.
 */
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

// ---- launch ----------------------------------------------------------------

function launch(dbPath) {
  return _electron.launch({
    executablePath: ELECTRON,
    args: [APP_DIR, `--user-data-dir=${USER_DATA_DIR}`],
    env: { ...process.env, VOLLI_DB_PATH: dbPath },
  });
}

// ---- DOM helpers -----------------------------------------------------------

/** The single board `<article>` whose mono id span equals `id` exactly. */
function cardById(page, id) {
  const exact = new RegExp(`^${id}$`);
  return page
    .locator("article")
    .filter({ has: page.locator("span.font-mono", { hasText: exact }) });
}

/** The Doc tab is labeled with the display id (round-2) — the reliable "detail is open" signal. */
function docTab(page) {
  return page.getByRole("tab", { name: DISPLAY_ID, exact: true });
}

async function detailOpen(page) {
  return (await docTab(page).count()) === 1;
}

/** Board is showing when the ticket's board card is mounted and no detail tab strip is. */
async function boardOpen(page) {
  return (await cardById(page, DISPLAY_ID).count()) === 1 && !(await detailOpen(page));
}

/** Read a ticket's persisted fields straight from the SQLite snapshot (bootstrap read IPC). */
async function readTicket(page, ticketId) {
  return page.evaluate(async (id) => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) return null;
    // BootstrapPayload keys tickets by project id (ticketsByProject).
    for (const list of Object.values(boot.data.ticketsByProject ?? {})) {
      const found = list.find((t) => t.id === id);
      if (found) return found;
    }
    return null;
  }, ticketId);
}

/**
 * Click a neutral, non-editable spot (the Doc tab) so a following Escape isn't
 * swallowed by a focused input / CodeMirror content, and any pending editor
 * autosave flushes on blur.
 */
async function blurToNeutral(page) {
  await docTab(page).click();
}

/** Double-click the board card to open its detail view; retries if the swap doesn't land. */
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

/** Escape back to the board from the detail (blurs any editor first). */
async function escapeToBoard(page) {
  await blurToNeutral(page);
  await page.keyboard.press("Escape");
  await waitUntil("board after Escape", () => boardOpen(page));
}

// ---- terminal (canvas — side-effect assertions only) -----------------------

/** Focus the single VISIBLE terminal canvas by clicking its centre. */
async function focusTerminal(page) {
  const box = await page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll("canvas"));
    const visible = canvases.find(
      (c) => c.offsetParent !== null && c.clientWidth > 0 && c.clientHeight > 0,
    );
    if (!visible) return null;
    const r = visible.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!box) throw new Error("no visible terminal canvas to focus");
  await page.mouse.click(box.x, box.y);
  await sleep(200);
}

/** Wait for a live terminal canvas with a real (non-zero) size, then let restty boot the shell + paint the prompt. */
async function waitForLiveCanvas(page, timeoutMs = 20000) {
  await page.waitForFunction(
    () => {
      const c = Array.from(document.querySelectorAll("canvas")).find(
        (el) => el.offsetParent !== null,
      );
      return c && c.clientWidth > 0 && c.clientHeight > 0;
    },
    { timeout: timeoutMs },
  );
  await sleep(2200);
}

/** Type a shell command into the focused terminal and submit it. */
async function runInTerminal(page, command) {
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

// ---- main ------------------------------------------------------------------

async function main() {
  let app = await launch(DB_PATH);

  try {
    // Profile isolation guard (same stance as board-smoke): a leaked default
    // profile would corrupt the developer's real data.
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
                  name: "Ticket Detail Project",
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
    }, INITIAL_TITLE);
    if (!seed.ok) throw new Error(`seed failed: ${seed.error}`);
    const TICKET_ID = seed.ticketId;

    // Reload so the board store hydrates the new ticket from SQLite.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await waitUntil("seeded card to render", () => boardOpen(page));

    // ===================================================================
    // 1. OPEN / CLOSE (Chrome-style tab strip, no breadcrumb)
    // ===================================================================
    await attempt(
      1,
      "Open/close: double-click opens detail (Doc tab = display id, no Artifacts tab, no breadcrumb); Escape and Board nav return; re-open works",
      async () => {
        await openTicketViaCard(page);
        const docTabId = (await docTab(page).textContent())?.trim();
        // The global-artifacts rework removed the Artifacts tab entirely.
        const noArtifactsTab =
          (await page.getByRole("tab", { name: "Artifacts", exact: true }).count()) === 0;
        const titleVisible = (await page.locator("h1", { hasText: INITIAL_TITLE }).count()) === 1;
        // The retired breadcrumb was a <header> carrying the display-id mono span;
        // the round-2 UX replaces it with the tablist, so no such header exists.
        const noBreadcrumbHeader =
          (await page
            .locator("header")
            .filter({
              has: page.locator("span.font-mono", { hasText: new RegExp(`^${DISPLAY_ID}$`) }),
            })
            .count()) === 0;

        await escapeToBoard(page);
        await openTicketViaCard(page);
        const reopened = await detailOpen(page);

        // Ticket detail is a child location of Board, so clicking the
        // already-active Board item must still close the detail.
        await page.getByRole("button", { name: "Board", exact: true }).click();
        const boardViaNav = await waitUntil("board after Board nav click", () => boardOpen(page));
        await openTicketViaCard(page);

        const ok =
          docTabId === DISPLAY_ID &&
          noArtifactsTab &&
          titleVisible &&
          noBreadcrumbHeader &&
          reopened &&
          !!boardViaNav;
        return {
          ok,
          detail: `docTab=${JSON.stringify(docTabId)} noArtifactsTab=${noArtifactsTab} title=${titleVisible} noBreadcrumb=${noBreadcrumbHeader} reopened=${reopened} boardNav=${!!boardViaNav}`,
        };
      },
    );

    // ===================================================================
    // 2. TITLE EDIT (+ board card reflects it after Escape-back)
    // ===================================================================
    await attempt(
      2,
      "Title edit: click→input, type + Enter renders; board card shows the new title after Escape-back",
      async () => {
        if (!(await detailOpen(page))) await openTicketViaCard(page);
        await page.locator("h1", { hasText: INITIAL_TITLE }).click();
        const input = page.getByRole("textbox", { name: "Ticket title" });
        await input.waitFor();
        await input.fill(RENAMED_TITLE);
        await page.keyboard.press("Enter");
        const renderedHeading = await waitUntil(
          "renamed heading",
          async () => (await page.locator("h1", { hasText: RENAMED_TITLE }).count()) === 1,
        );

        await escapeToBoard(page);
        const cardTitle = await waitUntil("card title update", async () => {
          const text = (
            await cardById(page, DISPLAY_ID).locator("p").first().textContent()
          )?.trim();
          return text === RENAMED_TITLE ? text : null;
        });
        const ok = renderedHeading && cardTitle === RENAMED_TITLE;
        return { ok, detail: `heading=${renderedHeading} card=${JSON.stringify(cardTitle)}` };
      },
    );

    // ===================================================================
    // 3. BODY EDITOR — CM6 live preview (# hide/reveal) + autosave
    // ===================================================================
    await attempt(
      3,
      "Body editor: contenteditable CM6 (no textarea); typed # renders styled with # hidden off-line + reveals on-caret; inline code; autosave persists",
      async () => {
        await openTicketViaCard(page);

        // The description surface is a contenteditable CM content div, not a textarea.
        const descEl = await page.evaluate(() => {
          const el = document.querySelector('[aria-label="Ticket description"]');
          return el
            ? {
                tag: el.tagName,
                ce: el.getAttribute("contenteditable"),
                role: el.getAttribute("role"),
              }
            : null;
        });
        const isLiveEditor =
          descEl?.tag === "DIV" &&
          descEl.ce === "true" &&
          (await page.locator(".cm-editor").count()) >= 1;

        // Type markdown into the editor. Line 0 is a plain paragraph so the
        // heading below renders collapsed even with the caret at the doc start.
        await page.locator(".cm-content").click();
        await page.keyboard.type(BODY_INTRO);
        await page.keyboard.press("Enter");
        await page.keyboard.press("Enter");
        await page.keyboard.type(`# ${BODY_HEADING}`);
        await page.keyboard.press("Enter");
        await page.keyboard.press("Enter");
        await page.keyboard.type(BODY_CODE);

        // Caret sits at the end (code line). The heading line renders as a styled
        // h1 with the `#` hidden; inline code renders too.
        const headingHidden = await waitUntil("heading renders with # hidden", async () => {
          if ((await page.locator(".cm-md-h1").count()) < 1) return false;
          const text = (await page.locator(".cm-md-h1").first().textContent())?.trim();
          return text === BODY_HEADING ? text : false;
        });
        const codeRendered = (await page.locator(".cm-md-code").count()) >= 1;

        // Reveal: clicking the heading line places the caret on it and the `#`
        // delimiter reappears (Obsidian-style live preview).
        await page.locator(".cm-md-h1").first().click();
        const headingRevealed = await waitUntil("heading reveals # on caret", async () => {
          const text = (await page.locator(".cm-md-h1").first().textContent())?.trim();
          return text?.startsWith("#") ? text : false;
        });

        // Autosave: blur (→ debounced flush) then confirm the body reached SQLite.
        await blurToNeutral(page);
        const persisted = await waitUntil("body autosaved to SQLite", async () => {
          const ticket = await readTicket(page, TICKET_ID);
          const body = ticket?.body ?? "";
          return body.includes(`# ${BODY_HEADING}`) &&
            body.includes("`code`") &&
            body.includes(BODY_INTRO)
            ? body
            : null;
        });

        const ok =
          isLiveEditor && !!headingHidden && codeRendered && !!headingRevealed && !!persisted;
        return {
          ok,
          detail: `liveEditor=${isLiveEditor} hidden=${JSON.stringify(headingHidden)} code=${codeRendered} revealed=${JSON.stringify(headingRevealed)} persisted=${persisted === EXPECTED_BODY}`,
        };
      },
    );

    // ===================================================================
    // 4. COMMENTS + ACTIVITY BUNCHING
    // ===================================================================
    await attempt(
      4,
      "Comments+activity: post (⌘↵) as You, edit inline, add+delete via confirm; created row + '+N more' bunch expands to reveal the retitled one-liner",
      async () => {
        const composer = page.getByRole("textbox", { name: "Add a comment" });

        // Post comment 1 with ⌘↵.
        await composer.fill(COMMENT_ONE);
        await page.keyboard.press("Meta+Enter");
        const c1 = page.locator("li").filter({ hasText: COMMENT_ONE });
        await waitUntil(
          "comment 1 to persist (edit affordance)",
          async () => (await c1.getByRole("button", { name: "Edit comment" }).count()) === 1,
        );
        const authoredByYou = (await c1.getByText("You", { exact: true }).count()) >= 1;

        // Edit it inline.
        await c1.getByRole("button", { name: "Edit comment" }).click();
        const editArea = c1.locator("textarea");
        await editArea.waitFor();
        await editArea.fill(COMMENT_ONE_EDITED);
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await waitUntil("comment 1 edited text", async () => {
          const has =
            (await page.locator("li").filter({ hasText: COMMENT_ONE_EDITED }).count()) >= 1;
          const goneOld = (await page.locator("li").filter({ hasText: COMMENT_ONE }).count()) === 0;
          return has && goneOld;
        });

        // Post comment 2, then delete it through its confirm dialog.
        await composer.fill(COMMENT_TWO);
        await page.keyboard.press("Meta+Enter");
        const c2 = page.locator("li").filter({ hasText: COMMENT_TWO });
        await waitUntil(
          "comment 2 to persist",
          async () => (await c2.getByRole("button", { name: "Delete comment" }).count()) === 1,
        );
        await c2.getByRole("button", { name: "Delete comment" }).click();
        await page.getByRole("alertdialog").waitFor();
        await page.getByRole("button", { name: "Delete", exact: true }).click();
        await waitUntil(
          "comment 2 gone",
          async () => (await page.locator("li").filter({ hasText: COMMENT_TWO }).count()) === 0,
        );

        // Activity bunching: created/retitled/body_edited collapse into one row
        // fronted by the highest-signal event ("created the ticket") with a
        // "+N more" caret. The retitled one-liner is hidden until it expands.
        const createdRow = page.locator("li").filter({ hasText: "created the ticket" });
        await waitUntil("created bunch row", async () => (await createdRow.count()) >= 1);
        const moreButton = createdRow.getByRole("button", { name: /\+\d+ more/ });
        const hasBunchToggle = (await moreButton.count()) >= 1;
        // Before expanding, the low-signal retitled line is collapsed away.
        const retitledHiddenFirst =
          (await page.getByText(`renamed to "${RENAMED_TITLE}"`, { exact: false }).count()) === 0;
        if (hasBunchToggle) await moreButton.first().click();
        const retitledRevealed = await waitUntil("retitled one-liner after expand", async () => {
          return (
            (await page.getByText(`renamed to "${RENAMED_TITLE}"`, { exact: false }).count()) >= 1
          );
        });
        const createdLine = (await createdRow.count()) >= 1;

        const survivingComment =
          (await page.locator("li").filter({ hasText: COMMENT_ONE_EDITED }).count()) >= 1;
        const ok =
          authoredByYou &&
          survivingComment &&
          createdLine &&
          hasBunchToggle &&
          retitledHiddenFirst &&
          retitledRevealed;
        return {
          ok,
          detail: `you=${authoredByYou} edited=${survivingComment} created=${createdLine} bunchToggle=${hasBunchToggle} hiddenFirst=${retitledHiddenFirst} revealed=${retitledRevealed}`,
        };
      },
    );

    // ===================================================================
    // 5. TICKET SESSION (create + env injection + keep-alive + rail chip)
    // ===================================================================
    await attempt(
      5,
      "Ticket session: rail New session boots a PTY, env injection ($VOLLI_TICKET/$VOLLI_ARTIFACTS_DIR), keep-alive across tabs, truthful Shell metadata",
      async () => {
        await fs.rm(PROBE_ENV, { force: true });
        await fs.rm(PROBE_ALIVE, { force: true });

        const aside = page.locator("aside");
        await aside.getByRole("button", { name: "New session" }).click();

        const sessionTab = page.getByRole("tab", { name: SESSION_INITIAL, exact: true });
        await waitUntil("session tab to appear", async () => (await sessionTab.count()) === 1);
        await waitForLiveCanvas(page);

        // A cold shell on a slow CI runner can still be sourcing rc files when
        // the first line is typed and silently drop it; a second identical line
        // against the now-live prompt recovers without weakening the assertion.
        let envLines = null;
        for (let typeAttempt = 0; typeAttempt < 2 && envLines === null; typeAttempt += 1) {
          await focusTerminal(page);
          await runInTerminal(
            page,
            `echo "$VOLLI_TICKET" > ${PROBE_ENV}; echo "$VOLLI_ARTIFACTS_DIR" >> ${PROBE_ENV}`,
          );
          envLines = await waitUntil("env probe file", async () => {
            const text = await readFileSafe(PROBE_ENV);
            if (text === null) return null;
            const lines = text
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l.length > 0);
            return lines.length >= 2 ? lines : null;
          }).catch(() => null);
        }
        if (envLines === null) throw new Error("env probe file never appeared (after retype)");
        const envOk = envLines[0] === DISPLAY_ID && envLines[1] === EXPECTED_ARTIFACTS_DIR;

        // Keep-alive across tabs: switch to Doc and back, type again.
        await docTab(page).click();
        await sleep(300);
        await sessionTab.click();
        await sleep(400);
        await focusTerminal(page);
        await runInTerminal(page, `echo alive-again > ${PROBE_ALIVE}`);
        const aliveOk = await waitUntil("keep-alive probe file", async () => {
          const text = await readFileSafe(PROBE_ALIVE);
          return text !== null && text.includes("alive-again");
        });

        const railRow = (await aside.getByText(SESSION_INITIAL, { exact: true }).count()) >= 1;
        const railChip = (await aside.getByText(/^(Working|Idle|Exited)$/).count()) >= 1;
        const shellSource = (await aside.getByText("Shell", { exact: true }).count()) === 1;
        const noFalseClaude = (await aside.getByText("Claude Code", { exact: true }).count()) === 0;

        // Active Sessions intentionally indexes Doing/Needs Review work only.
        // Put this live shell ticket into Doing through the real property UI,
        // then collapse Details again so the later rail-default check remains
        // meaningful.
        const details = aside.getByRole("button", { name: "Details", exact: true });
        await details.click();
        await aside.getByRole("button", { name: "Todo", exact: true }).click();
        await page.getByRole("menuitemradio", { name: "Doing", exact: true }).click();
        const doing = await waitUntil("ticket moves to Doing", async () => {
          const persisted = await readTicket(page, TICKET_ID);
          return persisted?.status === "doing";
        });
        await details.click();

        const ok =
          envOk && aliveOk && railRow && railChip && shellSource && noFalseClaude && !!doing;
        return {
          ok,
          detail: `env=${JSON.stringify(envLines)} envOk=${envOk} alive=${aliveOk} railRow=${railRow} railChip=${railChip} shell=${shellSource} noClaude=${noFalseClaude} doing=${!!doing}`,
        };
      },
    );

    // ===================================================================
    // 6. ACTIVE SESSIONS + RESIDENT KEEP-ALIVE — direct session destination
    // ===================================================================
    await attempt(
      6,
      "Active Sessions opens the exact live tab; its terminal canvas node + shell stay resident across ticket → board → session",
      async () => {
        await fs.rm(PROBE_NAV, { force: true });
        const sessionTab = page.getByRole("tab", { name: SESSION_INITIAL, exact: true });
        await sessionTab.click();
        await waitForLiveCanvas(page);

        // Tag the live terminal canvas so we can prove the SAME node survives.
        const marked = await page.evaluate(() => {
          const canvas = Array.from(document.querySelectorAll("canvas")).find(
            (c) => c.offsetParent !== null && c.clientWidth > 0 && c.clientHeight > 0,
          );
          if (!canvas) return false;
          canvas.dataset.e2eKeepalive = "kept-1";
          return true;
        });

        // Navigate away, then use the attention/index sidebar rather than the
        // board card. The row must restore the exact session destination.
        await escapeToBoard(page);
        const activeSessionRow = page
          .locator('[data-sidebar="menu-button"]')
          .filter({ hasText: SESSION_INITIAL })
          .filter({ hasText: DISPLAY_ID });
        await waitUntil(
          "live session row in Active Sessions",
          async () => (await activeSessionRow.count()) === 1,
        );
        await activeSessionRow.click();
        const exactTabSelected = await waitUntil("exact session tab selected", async () => {
          const tab = page.getByRole("tab", { name: SESSION_INITIAL, exact: true });
          return (await tab.count()) === 1 && (await tab.getAttribute("aria-selected")) === "true";
        });
        await waitForLiveCanvas(page);

        // The tagged canvas is still in the DOM (never unmounted/remounted).
        const nodeSurvived = await waitUntil("marked canvas survives nav", async () =>
          page.evaluate(() =>
            Array.from(document.querySelectorAll("canvas")).some(
              (c) => c.dataset.e2eKeepalive === "kept-1",
            ),
          ),
        );

        // And the underlying shell is the same live process.
        await focusTerminal(page);
        await runInTerminal(page, `echo nav-survivor > ${PROBE_NAV}`);
        const shellAlive = await waitUntil("shell alive after nav", async () => {
          const text = await readFileSafe(PROBE_NAV);
          return text !== null && text.includes("nav-survivor");
        });

        const ok = marked && !!exactTabSelected && !!nodeSurvived && !!shellAlive;
        return {
          ok,
          detail: `marked=${marked} exactTab=${!!exactTabSelected} nodeSurvived=${!!nodeSurvived} shellAlive=${!!shellAlive}`,
        };
      },
    );

    // ===================================================================
    // 6b. TERMINAL FOCUS — thin chrome, no sidebars, same resident canvas
    // ===================================================================
    await attempt(
      "6b",
      "Terminal focus reclaims sidebars/tab rail, keeps one thin chrome row, preserves the live canvas, and Escape restores the workspace",
      async () => {
        const marked = await page.evaluate(() => {
          const canvas = Array.from(document.querySelectorAll("canvas")).find(
            (candidate) =>
              candidate.offsetParent !== null &&
              candidate.clientWidth > 0 &&
              candidate.clientHeight > 0,
          );
          if (!canvas) return false;
          canvas.dataset.e2eFocus = "focus-1";
          return true;
        });
        await page.getByRole("button", { name: "Enter terminal focus" }).click();
        const focused = await waitUntil("terminal focus geometry", async () =>
          page.evaluate(() => {
            const sidebar = document.querySelector('[data-sidebar="sidebar"]');
            const inset = document.querySelector('[data-slot="sidebar-inset"]');
            const chrome = document.querySelector(".app-region-drag");
            const markedCanvas = document.querySelector('canvas[data-e2e-focus="focus-1"]');
            const state = {
              sidebarHidden: sidebar?.closest('[aria-hidden="true"]') !== null,
              insetLeft: inset?.getBoundingClientRect().left ?? -1,
              chromeHeight: chrome?.getBoundingClientRect().height ?? -1,
              tablists: Array.from(document.querySelectorAll('[role="tablist"]')).filter(
                (element) =>
                  element instanceof HTMLElement &&
                  element.offsetParent !== null &&
                  element.getBoundingClientRect().height > 0,
              ).length,
              asides: document.querySelectorAll("aside").length,
              canvasVisible:
                markedCanvas instanceof HTMLCanvasElement && markedCanvas.offsetParent !== null,
            };
            return state.sidebarHidden && state.insetLeft === 0 && state.canvasVisible
              ? state
              : false;
          }),
        );
        const focusGeometry =
          focused.sidebarHidden &&
          focused.insetLeft === 0 &&
          focused.chromeHeight === 40 &&
          focused.tablists === 0 &&
          focused.asides === 0 &&
          focused.canvasVisible;

        await page.keyboard.press("Escape");
        const restored = await waitUntil("workspace geometry restored", async () =>
          page.evaluate(() => {
            const inset = document.querySelector('[data-slot="sidebar-inset"]');
            const markedCanvas = document.querySelector('canvas[data-e2e-focus="focus-1"]');
            const state = {
              insetLeft: inset?.getBoundingClientRect().left ?? 0,
              tablists: Array.from(document.querySelectorAll('[role="tablist"]')).filter(
                (element) =>
                  element instanceof HTMLElement &&
                  element.offsetParent !== null &&
                  element.getBoundingClientRect().height > 0,
              ).length,
              asides: document.querySelectorAll("aside").length,
              canvasVisible:
                markedCanvas instanceof HTMLCanvasElement && markedCanvas.offsetParent !== null,
            };
            return state.insetLeft > 0 && state.canvasVisible ? state : false;
          }),
        );
        const restoredGeometry =
          restored.insetLeft > 0 &&
          restored.tablists === 1 &&
          restored.asides === 1 &&
          restored.canvasVisible;
        const ticketStillOpen = await detailOpen(page);

        const ok = marked && focusGeometry && restoredGeometry && ticketStillOpen;
        return {
          ok,
          detail: `marked=${marked} focused=${JSON.stringify(focused)} restored=${JSON.stringify(restored)} ticketOpen=${ticketStillOpen}`,
        };
      },
    );

    // ===================================================================
    // 7. SESSION RENAME (double-click tab → tab + rail update)
    // ===================================================================
    await attempt(
      7,
      "Session rename: double-click the session tab, type, Enter; the new title shows on the tab and the rail row",
      async () => {
        const sessionTab = page.getByRole("tab", { name: SESSION_INITIAL, exact: true });
        await sessionTab.dblclick();
        const renameInput = page.getByRole("textbox", { name: `Rename ${SESSION_INITIAL}` });
        await renameInput.waitFor();
        await renameInput.fill(SESSION_RENAMED);
        await page.keyboard.press("Enter");

        const tabRenamed = await waitUntil("session tab shows new title", async () => {
          const hasNew =
            (await page.getByRole("tab", { name: SESSION_RENAMED, exact: true }).count()) === 1;
          const goneOld =
            (await page.getByRole("tab", { name: SESSION_INITIAL, exact: true }).count()) === 0;
          return hasNew && goneOld;
        });
        const aside = page.locator("aside");
        const railRenamed = await waitUntil("rail row shows new title", async () => {
          return (await aside.getByText(SESSION_RENAMED, { exact: true }).count()) >= 1;
        });

        const ok = !!tabRenamed && !!railRenamed;
        return { ok, detail: `tab=${!!tabRenamed} rail=${!!railRenamed}` };
      },
    );

    // ===================================================================
    // 8. RAIL IS SESSIONS-FIRST — Details drawer + no harness anywhere
    // ===================================================================
    await attempt(
      8,
      "Rail: sessions-first with a collapsed-by-default Details drawer (status/priority/labels); no Harness row anywhere; board filter bar has no Harness chip",
      async () => {
        const aside = page.locator("aside");
        // Sessions section is present at the top of the rail.
        const sessionsHeading =
          (await aside.getByRole("heading", { name: "Sessions" }).count()) >= 1;

        // Details drawer: collapsed by default (aria-expanded=false), its
        // status/priority controls not shown until expanded.
        const detailsButton = aside.getByRole("button", { name: "Details", exact: true });
        const collapsedByDefault = (await detailsButton.getAttribute("aria-expanded")) === "false";
        await detailsButton.click();
        const expanded = await waitUntil("Details drawer expands", async () => {
          return (
            (await aside.getByText("Status", { exact: false }).count()) >= 1 &&
            (await aside.getByText("Priority", { exact: false }).count()) >= 1
          );
        });

        // No harness identity anywhere in the ticket detail rail.
        const noHarnessInRail = (await aside.getByText(/harness/i).count()) === 0;

        // Board filter bar carries no Harness chip either.
        await escapeToBoard(page);
        const noHarnessOnBoard = (await page.getByText(/harness/i).count()) === 0;
        await openTicketViaCard(page);

        const ok =
          sessionsHeading &&
          collapsedByDefault &&
          !!expanded &&
          noHarnessInRail &&
          noHarnessOnBoard;
        return {
          ok,
          detail: `sessions=${sessionsHeading} collapsed=${collapsedByDefault} expanded=${!!expanded} railNoHarness=${noHarnessInRail} boardNoHarness=${noHarnessOnBoard}`,
        };
      },
    );

    // ===================================================================
    // 9. NAV HISTORY (←/→ buttons + ⌘[ / ⌘])
    // ===================================================================
    await attempt(
      9,
      "Nav history: chrome ← returns to Board, → reopens the ticket; ⌘[ / ⌘] do the same",
      async () => {
        if (!(await detailOpen(page))) await openTicketViaCard(page);

        // The Back button is enabled once there's history behind the open ticket.
        const back = page.getByRole("button", { name: "Back", exact: true });
        const forward = page.getByRole("button", { name: "Forward", exact: true });
        await waitUntil("Back enabled with ticket open", async () => !(await back.isDisabled()));

        await back.click();
        await waitUntil("board after nav Back", () => boardOpen(page));
        await waitUntil("Forward enabled after Back", async () => !(await forward.isDisabled()));
        await forward.click();
        await waitUntil("detail after nav Forward", () => detailOpen(page));

        // Keyboard parity: ⌘[ back to board, ⌘] forward to detail (blur first so
        // the shortcut isn't swallowed as an editor outdent).
        await blurToNeutral(page);
        await page.keyboard.press("Meta+BracketLeft");
        const boardViaKey = await waitUntil("board via ⌘[", () => boardOpen(page));
        await page.keyboard.press("Meta+BracketRight");
        const detailViaKey = await waitUntil("detail via ⌘]", () => detailOpen(page));

        const ok = !!boardViaKey && !!detailViaKey;
        return { ok, detail: `buttons+keys ok=${!!boardViaKey && !!detailViaKey}` };
      },
    );

    // ===================================================================
    // 10. RAIL TOGGLE (button + ⌥⌘B) — leave collapsed for restart
    // ===================================================================
    await attempt(
      10,
      "Rail toggle: the chrome rail button and ⌥⌘B hide/show the right rail; left collapsed for the restart-persistence check",
      async () => {
        if (!(await detailOpen(page))) await openTicketViaCard(page);
        const aside = page.locator("aside");
        await waitUntil("rail visible initially", async () => (await aside.count()) === 1);

        // Chrome-bar mirrored toggle hides the rail.
        await page.getByRole("button", { name: "Hide details rail" }).click();
        const hiddenByButton = await waitUntil("rail hidden by button", async () => {
          return (await aside.count()) === 0;
        });

        // ⌥⌘B brings it back.
        await page.keyboard.press("Alt+Meta+b");
        const shownByShortcut = await waitUntil("rail shown by ⌥⌘B", async () => {
          return (await aside.count()) === 1;
        });

        // ⌥⌘B again to leave it collapsed — the restart check asserts it persisted.
        await page.keyboard.press("Alt+Meta+b");
        const collapsedForRestart = await waitUntil("rail collapsed for restart", async () => {
          return (await aside.count()) === 0;
        });

        const ok = !!hiddenByButton && !!shownByShortcut && !!collapsedForRestart;
        return {
          ok,
          detail: `hideBtn=${!!hiddenByButton} showKey=${!!shownByShortcut} collapsed=${!!collapsedForRestart}`,
        };
      },
    );

    // ===================================================================
    // 11. RESTART PERSISTENCE
    // ===================================================================
    // Make sure the open-ticket write reached app_state before we close.
    await waitUntil("openTicketId to persist to app_state", async () => {
      const raw = await page.evaluate(async () => {
        const res = await window.api.data.bootstrap();
        if (!res.ok) return null;
        return res.data.appState["volli:workspace"] ?? null;
      });
      return typeof raw === "string" && raw.includes(TICKET_ID);
    });

    await app.close();
    app = await launch(DB_PATH);
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    await attempt(
      11,
      "Restart: detail reopens (persisted openTicketId); data + collapsed rail survive; Back returns to Board with fresh history",
      async () => {
        await waitUntil("detail view to reopen after relaunch", () => detailOpen(page), {
          timeout: 20000,
        });
        const docTabId = (await docTab(page).textContent())?.trim();
        const titleOk = (await page.locator("h1", { hasText: RENAMED_TITLE }).count()) === 1;

        // Body markdown survived (rendered live on the default Doc tab; line-0
        // paragraph keeps the heading collapsed with the caret at doc start).
        const bodyOk = await waitUntil("persisted body render", async () => {
          const h1 = await page.locator(".cm-md-h1").count();
          const code = await page.locator(".cm-md-code").count();
          const ticket = await readTicket(page, TICKET_ID);
          return h1 >= 1 && code >= 1 && ticket?.body === EXPECTED_BODY;
        });

        // Rail collapsed state persisted across restart (no rail rendered yet).
        const railCollapsedPersisted = (await page.locator("aside").count()) === 0;
        // Bring it back to assert the session record survived.
        await page.keyboard.press("Alt+Meta+b");
        const aside = page.locator("aside");
        await waitUntil("rail restored after restart", async () => (await aside.count()) === 1);

        // The surviving (edited) comment is present; the deleted one is not.
        const commentOk = await waitUntil("persisted comment", async () => {
          const kept =
            (await page.locator("li").filter({ hasText: COMMENT_ONE_EDITED }).count()) >= 1;
          const deletedGone =
            (await page.locator("li").filter({ hasText: COMMENT_TWO }).count()) === 0;
          return kept && deletedGone;
        });

        // The prior session no longer clutters the working set: History is
        // collapsed by default. Expanding it restores the renamed row and its
        // truthful source/status metadata.
        const historyButton = aside.getByRole("button", { name: /History/ });
        const historyCollapsed =
          (await historyButton.getAttribute("aria-expanded")) === "false" &&
          (await aside.getByText(SESSION_RENAMED, { exact: true }).count()) === 0;
        await historyButton.click();
        const sessionOk = await waitUntil(
          "prior renamed session expands from history",
          async () => {
            const row = (await aside.getByText(SESSION_RENAMED, { exact: true }).count()) >= 1;
            const shell = (await aside.getByText("Shell", { exact: true }).count()) >= 1;
            // History rows trail with when the session ended, not a redundant
            // "Exited" chip — the drawer itself already says these are past.
            const endedAgo = (await aside.getByText(/^(just now|\d+[mhdw] ago)$/).count()) >= 1;
            return row && shell && endedAgo;
          },
        );
        // Navigation history is deliberately in-memory, so a relaunch has no
        // prior board snapshot. The chrome Back action still needs a semantic
        // fallback from persisted ticket detail to its parent Board.
        const back = page.getByRole("button", { name: "Back", exact: true });
        const backEnabledAfterRestart = !(await back.isDisabled());
        if (backEnabledAfterRestart) await back.click();
        const boardViaRestartBack = backEnabledAfterRestart
          ? await waitUntil("board after Back from restarted detail", () => boardOpen(page))
          : false;

        const ok =
          docTabId === DISPLAY_ID &&
          titleOk &&
          !!bodyOk &&
          railCollapsedPersisted &&
          !!commentOk &&
          historyCollapsed &&
          !!sessionOk &&
          !!boardViaRestartBack;
        return {
          ok,
          detail: `docTab=${JSON.stringify(docTabId)} title=${titleOk} body=${!!bodyOk} railCollapsed=${railCollapsedPersisted} comment=${!!commentOk} historyCollapsed=${historyCollapsed} session=${!!sessionOk} restartBack=${!!boardViaRestartBack}`,
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
