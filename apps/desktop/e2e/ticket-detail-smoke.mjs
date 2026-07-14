/**
 * End-to-end acceptance smoke for Volli's ticket-detail view (docs/plans/
 * ticket-detail-mvp.md). Drives the REAL packaged renderer through Playwright
 * against a scratch SQLite database (`VOLLI_DB_PATH`) + isolated user-data dir,
 * exercising the whole full-page detail surface a user touches:
 *
 *   1. Open/close   — double-click a card opens the detail (breadcrumb display
 *      id + title heading); Escape returns to the board; re-open; the "Board"
 *      breadcrumb returns.
 *   2. Title edit   — click-to-edit the heading, Enter commits + renders, and
 *      the board card shows the new title after Escape-back.
 *   3. Body edit    — click-to-edit the markdown body, blur renders real
 *      typeset elements (h1 / li / code inside `.typeset`, not raw markdown).
 *   4. Comments+activity — post a comment (⌘↵) as "You", edit it inline, add a
 *      second and delete it via its confirm flow; the activity one-liners show
 *      the `created` and (post-rename) `retitled` events.
 *   5. Artifacts    — a markdown file dropped into the ticket's on-disk
 *      `.volli/tickets/<ID>/artifacts/` appears in the tab, renders as markdown,
 *      edits+saves back to disk, and promotes (the file physically moves to the
 *      project `.volli/artifacts/` tier); `.volli/.gitignore` is `*`.
 *   6. Ticket session — "New session" boots a ticket-scoped PTY; env injection
 *      is proven with the file-probe pattern ($VOLLI_TICKET == display id,
 *      $VOLLI_TICKET_DIR == the ticket's `.volli/tickets/<ID>` path); switching
 *      Doc ↔ session keeps the terminal alive; the rail shows a status chip.
 *   7. Restart      — close + relaunch against the SAME app-data dir: the ticket
 *      detail reopens (persisted openTicketId), the edited title/body and the
 *      surviving comment are intact, and the prior session is listed as exited.
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
 *     pnpm -w run build                         # produce dist/ + dist-electron/
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

// On-disk `.volli` locations the artifact + session flows assert against.
const VOLLI_DIR = join(PROJECT_DIR, ".volli");
const TICKET_ARTIFACTS_DIR = join(VOLLI_DIR, "tickets", DISPLAY_ID, "artifacts");
const PROJECT_ARTIFACTS_DIR = join(VOLLI_DIR, "artifacts");
const GITIGNORE_PATH = join(VOLLI_DIR, ".gitignore");
// What main injects as VOLLI_TICKET_DIR (ticketDir(projectPath, displayId) — the
// ticket dir itself, NOT its artifacts subdir).
const EXPECTED_TICKET_DIR = join(VOLLI_DIR, "tickets", DISPLAY_ID);

const PROBE_ENV = join(SCRATCH, "probe-env.txt");
const PROBE_ALIVE = join(SCRATCH, "probe-alive.txt");

const INITIAL_TITLE = "Original ticket title";
const RENAMED_TITLE = "Renamed ticket title";
const BODY_MARKDOWN = "# Body Heading\n\n- alpha item\n- beta item\n\nInline `snippet` code.\n";
const ARTIFACT_NAME = "probe.md";
const ARTIFACT_MARKDOWN = "# Probe Artifact\n\n- one\n- two\n\nInline `x` code.\n";
const ARTIFACT_EDITED = "# Probe Edited\n\nUpdated artifact body with a `token`.\n";
const COMMENT_ONE = "First work log note";
const COMMENT_ONE_EDITED = "Edited work log note";
const COMMENT_TWO = "Second note to delete";

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

/** The Doc tab exists only inside the detail view — the reliable "detail is open" signal. */
async function detailOpen(page) {
  return (await page.getByRole("tab", { name: "Doc", exact: true }).count()) === 1;
}

/** Board is showing when the ticket's board card is mounted and no detail tab strip is. */
async function boardOpen(page) {
  return (await cardById(page, DISPLAY_ID).count()) === 1 && !(await detailOpen(page));
}

/** The detail breadcrumb header (scoped by the display-id mono span it carries). */
function breadcrumbHeader(page) {
  return page
    .locator("header")
    .filter({ has: page.locator("span.font-mono", { hasText: new RegExp(`^${DISPLAY_ID}$`) }) });
}

/** Click a neutral, non-editable spot (the breadcrumb display id) so a following Escape/blur isn't swallowed by an input. */
async function blurToNeutral(page) {
  await breadcrumbHeader(page).locator("span.font-mono").first().click();
}

/** Double-click the board card to open its detail view; retries once if the swap doesn't land. */
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
    // 1. OPEN / CLOSE
    // ===================================================================
    await attempt(
      1,
      "Open/close: double-click opens detail (breadcrumb id + title); Escape returns; breadcrumb returns",
      async () => {
        await openTicketViaCard(page);
        const breadcrumbId = await breadcrumbHeader(page)
          .locator("span.font-mono")
          .first()
          .textContent();
        const titleVisible = (await page.locator("h1", { hasText: INITIAL_TITLE }).count()) === 1;

        // Escape → board.
        await blurToNeutral(page);
        await page.keyboard.press("Escape");
        await waitUntil("board after Escape", () => boardOpen(page));

        // Re-open, then close via the breadcrumb "Board" button.
        await openTicketViaCard(page);
        const reopened = await detailOpen(page);
        await breadcrumbHeader(page).getByRole("button", { name: "Board", exact: true }).click();
        await waitUntil("board after breadcrumb", () => boardOpen(page));

        const ok = breadcrumbId?.trim() === DISPLAY_ID && titleVisible && reopened;
        return {
          ok,
          detail: `breadcrumb=${JSON.stringify(breadcrumbId?.trim())} title=${titleVisible} reopened=${reopened}`,
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
        await openTicketViaCard(page);
        await page.locator("h1", { hasText: INITIAL_TITLE }).click();
        const input = page.getByRole("textbox", { name: "Ticket title" });
        await input.waitFor();
        await input.fill(RENAMED_TITLE);
        await page.keyboard.press("Enter");
        const renderedHeading = await waitUntil(
          "renamed heading",
          async () => (await page.locator("h1", { hasText: RENAMED_TITLE }).count()) === 1,
        );

        // Escape back to the board and confirm the card text updated.
        await blurToNeutral(page);
        await page.keyboard.press("Escape");
        await waitUntil("board after title edit", () => boardOpen(page));
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
    // 3. BODY EDIT + MARKDOWN RENDER
    // ===================================================================
    await attempt(
      3,
      "Body edit: click placeholder→textarea, type markdown, blur renders real h1/li/code in .typeset",
      async () => {
        await openTicketViaCard(page);
        await page.getByRole("button", { name: /Add description/ }).click();
        const textarea = page.getByRole("textbox", { name: "Ticket description" });
        await textarea.waitFor();
        await textarea.fill(BODY_MARKDOWN);
        // Blur (click a neutral spot) → the editor flips back to rendered typeset.
        await blurToNeutral(page);

        const body = page.locator('[aria-label="Edit description"] .typeset');
        const counts = await waitUntil("typeset body render", async () => {
          const h1 = await body.locator("h1").count();
          const li = await body.locator("li").count();
          const code = await body.locator("code").count();
          if (h1 >= 1 && li >= 2 && code >= 1) return { h1, li, code };
          return null;
        });
        const headingText = (await body.locator("h1").first().textContent())?.trim();
        // Raw markdown must NOT be shown verbatim (no leading "# " literal).
        const rawLeaked = (await body.getByText("# Body Heading", { exact: true }).count()) > 0;
        const ok =
          counts.h1 >= 1 &&
          counts.li >= 2 &&
          counts.code >= 1 &&
          headingText === "Body Heading" &&
          !rawLeaked;
        return {
          ok,
          detail: `h1=${counts.h1} li=${counts.li} code=${counts.code} heading=${JSON.stringify(headingText)} rawLeaked=${rawLeaked}`,
        };
      },
    );

    // ===================================================================
    // 4. COMMENTS + ACTIVITY
    // ===================================================================
    await attempt(
      4,
      "Comments+activity: post (⌘↵) as You, edit inline, add+delete via confirm; created + retitled one-liners",
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

        // Activity one-liners: created (always) + retitled (from flow 2).
        const createdLine =
          (await page.getByText("created the ticket", { exact: false }).count()) >= 1;
        const retitledLine =
          (await page.getByText(`renamed to "${RENAMED_TITLE}"`, { exact: false }).count()) >= 1;

        const survivingComment =
          (await page.locator("li").filter({ hasText: COMMENT_ONE_EDITED }).count()) >= 1;
        const ok = authoredByYou && survivingComment && createdLine && retitledLine;
        return {
          ok,
          detail: `you=${authoredByYou} edited=${survivingComment} created=${createdLine} retitled=${retitledLine}`,
        };
      },
    );

    // ===================================================================
    // 5. ARTIFACTS
    // ===================================================================
    await attempt(
      5,
      "Artifacts: disk file appears, renders markdown, edit+Save writes disk, Promote moves tiers; .volli/.gitignore is *",
      async () => {
        // Drop a markdown file straight onto disk in the ticket tier (the dir may
        // not exist yet — the app only creates it lazily), the way an agent would.
        await fs.mkdir(TICKET_ARTIFACTS_DIR, { recursive: true });
        await fs.writeFile(join(TICKET_ARTIFACTS_DIR, ARTIFACT_NAME), ARTIFACT_MARKDOWN, "utf8");

        // Open the Artifacts tab (mount subscribes → ensures .volli + gitignore,
        // and the initial list picks up the file we just wrote).
        await page.getByRole("tab", { name: "Artifacts", exact: true }).click();

        const ticketSection = page
          .locator("section")
          .filter({ has: page.getByRole("heading", { name: "Ticket artifacts" }) });
        const projectSection = page
          .locator("section")
          .filter({ has: page.getByRole("heading", { name: "Project artifacts" }) });

        await waitUntil(
          "artifact row to appear in Ticket tier",
          async () => (await ticketSection.getByText(ARTIFACT_NAME, { exact: true }).count()) >= 1,
        );

        // .volli/.gitignore self-ignore was written by the tab's subscribe().
        const gitignore = await waitUntil("`.volli/.gitignore` on disk", () =>
          readFileSafe(GITIGNORE_PATH),
        );

        // Select → rendered markdown (real typeset elements in the viewer).
        await ticketSection.getByText(ARTIFACT_NAME, { exact: true }).click();
        const viewer = page.locator(".typeset");
        const rendered = await waitUntil("artifact markdown render", async () => {
          const h1 = await viewer.locator("h1").count();
          const li = await viewer.locator("li").count();
          const code = await viewer.locator("code").count();
          return h1 >= 1 && li >= 2 && code >= 1 ? { h1, li, code } : null;
        });

        // Edit + Save → the on-disk file content changes.
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        const editArea = page.locator("textarea");
        await editArea.waitFor();
        await editArea.fill(ARTIFACT_EDITED);
        await page.getByRole("button", { name: "Save", exact: true }).click();
        const savedContent = await waitUntil("edited artifact on disk", async () => {
          const text = await readFileSafe(join(TICKET_ARTIFACTS_DIR, ARTIFACT_NAME));
          return text === ARTIFACT_EDITED ? text : null;
        });

        // Promote → the file physically moves to the project tier.
        await page.getByRole("button", { name: "Promote to project", exact: true }).click();
        await waitUntil("artifact promoted on disk (moved tiers)", async () => {
          const inProject = await pathExists(join(PROJECT_ARTIFACTS_DIR, ARTIFACT_NAME));
          const goneFromTicket = !(await pathExists(join(TICKET_ARTIFACTS_DIR, ARTIFACT_NAME)));
          return inProject && goneFromTicket;
        });
        await waitUntil("promoted artifact under Project artifacts in UI", async () => {
          const inProjectUi =
            (await projectSection.getByText(ARTIFACT_NAME, { exact: true }).count()) >= 1;
          const goneFromTicketUi =
            (await ticketSection.getByText(ARTIFACT_NAME, { exact: true }).count()) === 0;
          return inProjectUi && goneFromTicketUi;
        });

        const ok =
          rendered.h1 >= 1 &&
          rendered.li >= 2 &&
          rendered.code >= 1 &&
          gitignore === "*\n" &&
          savedContent === ARTIFACT_EDITED;
        return {
          ok,
          detail: `render=${JSON.stringify(rendered)} gitignore=${JSON.stringify(gitignore)} saved=${savedContent === ARTIFACT_EDITED}`,
        };
      },
    );

    // ===================================================================
    // 6. TICKET SESSION (create + env injection + keep-alive + rail chip)
    // ===================================================================
    await attempt(
      6,
      "Ticket session: New session boots a PTY, env injection ($VOLLI_TICKET/$VOLLI_TICKET_DIR), keep-alive across tabs, rail chip",
      async () => {
        await fs.rm(PROBE_ENV, { force: true });
        await fs.rm(PROBE_ALIVE, { force: true });

        const aside = page.locator("aside");
        await aside.getByRole("button", { name: "New session" }).click();

        // The session tab appears + activates.
        const sessionTab = page.getByRole("tab", { name: "Session 1", exact: true });
        await waitUntil("session tab to appear", async () => (await sessionTab.count()) === 1);
        await waitForLiveCanvas(page);

        // Env probe via the shell — no DOM text, only the file it writes.
        await focusTerminal(page);
        await runInTerminal(
          page,
          `echo "$VOLLI_TICKET" > ${PROBE_ENV}; echo "$VOLLI_TICKET_DIR" >> ${PROBE_ENV}`,
        );
        const envLines = await waitUntil("env probe file", async () => {
          const text = await readFileSafe(PROBE_ENV);
          if (text === null) return null;
          const lines = text
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
          return lines.length >= 2 ? lines : null;
        });
        const envOk = envLines[0] === DISPLAY_ID && envLines[1] === EXPECTED_TICKET_DIR;

        // Keep-alive: switch to Doc and back, type again — same shell must respond.
        await page.getByRole("tab", { name: "Doc", exact: true }).click();
        await sleep(300);
        await sessionTab.click();
        await sleep(400);
        await focusTerminal(page);
        await runInTerminal(page, `echo alive-again > ${PROBE_ALIVE}`);
        const aliveOk = await waitUntil("keep-alive probe file", async () => {
          const text = await readFileSafe(PROBE_ALIVE);
          return text !== null && text.includes("alive-again");
        });

        // Rail shows the session row with a status chip.
        const railRow = (await aside.getByText("Session 1", { exact: true }).count()) >= 1;
        const railChip = (await aside.getByText(/^(Working|Idle|Exited)$/).count()) >= 1;

        const ok = envOk && aliveOk && railRow && railChip;
        return {
          ok,
          detail: `env=${JSON.stringify(envLines)} envOk=${envOk} alive=${aliveOk} railRow=${railRow} railChip=${railChip}`,
        };
      },
    );

    // ===================================================================
    // 7. RESTART PERSISTENCE
    // ===================================================================
    // Make sure the open-ticket write reached app_state before we close (the
    // workspace store persists it via an async write-through), so the relaunch
    // has something to restore.
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
      7,
      "Restart: detail reopens (persisted openTicketId); edited title/body + comment intact; prior session listed as exited",
      async () => {
        // Detail reopens on its own from the persisted openTicketId.
        await waitUntil("detail view to reopen after relaunch", () => detailOpen(page), {
          timeout: 20000,
        });
        const breadcrumbId = (
          await breadcrumbHeader(page).locator("span.font-mono").first().textContent()
        )?.trim();
        const titleOk = (await page.locator("h1", { hasText: RENAMED_TITLE }).count()) === 1;

        // Body markdown survived (rendered typeset on the default Doc tab).
        const body = page.locator('[aria-label="Edit description"] .typeset');
        const bodyOk = await waitUntil("persisted body render", async () => {
          const h1 = await body.locator("h1").count();
          const li = await body.locator("li").count();
          const code = await body.locator("code").count();
          return h1 >= 1 && li >= 2 && code >= 1;
        });

        // The surviving (edited) comment is present; the deleted one is not.
        const commentOk = await waitUntil("persisted comment", async () => {
          const kept =
            (await page.locator("li").filter({ hasText: COMMENT_ONE_EDITED }).count()) >= 1;
          const deletedGone =
            (await page.locator("li").filter({ hasText: COMMENT_TWO }).count()) === 0;
          return kept && deletedGone;
        });

        // The prior session is listed in the rail as an exited/past session.
        const aside = page.locator("aside");
        const sessionOk = await waitUntil("prior session listed as exited", async () => {
          const row = (await aside.getByText("Session 1", { exact: true }).count()) >= 1;
          const exited = (await aside.getByText("Exited", { exact: true }).count()) >= 1;
          return row && exited;
        });

        const ok = breadcrumbId === DISPLAY_ID && titleOk && bodyOk && commentOk && sessionOk;
        return {
          ok,
          detail: `breadcrumb=${JSON.stringify(breadcrumbId)} title=${titleOk} body=${bodyOk} comment=${commentOk} session=${sessionOk}`,
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
