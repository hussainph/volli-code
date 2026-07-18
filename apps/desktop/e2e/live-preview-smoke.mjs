/**
 * End-to-end smoke for the markdown live-preview REVEAL rules (PR #63 follow-up
 * bug: raw formatting delimiters — `##`, `**`, `~~` — stayed visible until a
 * click forced a decoration rebuild).
 *
 * Two root causes, both asserted here:
 *   a. Reveal ignored focus: a blurred editor still has a selection (initially
 *      0,0 — the first line), so the caret line's raw syntax stayed revealed
 *      while "not editing". Clicking in and away moved the caret, which is why
 *      it "fixed itself".
 *   b. The decoration plugin ignored the background parse: lezer parses
 *      markdown incrementally, and the "more is parsed now" notification is a
 *      language-state-only transaction (no doc/selection/viewport flags), so
 *      content past the parse frontier kept raw syntax until the next
 *      interaction.
 *
 * Checks (against a seeded ticket body, never typing into the editor first):
 *   1. Blurred mount — the first line (`## First Heading`) shows NO raw `##`.
 *   2. Blurred mount — no `**`/`~~` delimiters visible anywhere in view.
 *   3. Caret reveal still works — clicking the heading line reveals its `##`.
 *   4. Blur re-collapses — clicking outside the editor (Doc tab) hides `##`
 *      again even though the CM selection still touches that line.
 *   5. Background-parse convergence — wheel-scroll (no clicks) to a heading
 *      deep in a large body; it must render as a heading (styled line, no raw
 *      `##`) without any interaction beyond the scroll.
 *
 * This is a MANUALLY-RUN smoke (needs a display + the built app); it is NOT
 * wired into `vp test`.
 *
 *   Run:
 *     pnpm run build
 *     node apps/desktop/e2e/live-preview-smoke.mjs
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

const SCRATCH = await fs.mkdtemp(join(os.tmpdir(), "volli-live-preview-smoke-"));
const USER_DATA_DIR = join(SCRATCH, "user-data");
const DB_PATH = join(SCRATCH, "volli.db");
await fs.mkdir(USER_DATA_DIR, { recursive: true });
const PROJECT_DIR = await fs.realpath(await fs.mkdtemp(join(SCRATCH, "project-")));

const PROJECT_SEED_ID = "live-preview-project";
const TICKET_PREFIX = "VC";
const DISPLAY_ID = `${TICKET_PREFIX}-1`;

// The seeded body: formatting on the FIRST line (the default 0,0 selection's
// line — root cause a), then a large filler so the tail heading sits past the
// initial parse frontier (root cause b).
const FILLER = Array.from(
  { length: 400 },
  (_, i) => `Filler paragraph ${i} with some plain prose to pad the document out.`,
).join("\n\n");
const TAIL_HEADING = "Deep Tail Heading";
const BODY = [
  "## First Heading",
  "",
  "Intro **bold** and ~~struck~~ text.",
  "",
  FILLER,
  "",
  `## ${TAIL_HEADING}`,
  "",
  "Tail line.",
].join("\n");

// ---- tiny test harness -----------------------------------------------------

const results = [];
function check(n, label, ok, detail = "") {
  const status = ok ? "PASS" : "FAIL";
  results.push({ n, ok });
  console.log(`  [${status}] ${n}. ${label}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attempt(n, label, fn) {
  try {
    const { ok, detail } = await fn();
    check(n, label, ok, detail);
  } catch (error) {
    check(n, label, false, `threw: ${error?.message ?? error}`);
  }
}

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

/** The rendered text of the line containing `text` (empty string if absent). */
async function lineText(page, text) {
  const line = page.locator(".cm-line", { hasText: text }).first();
  if ((await line.count()) === 0) return "";
  return (await line.textContent()) ?? "";
}

// ---- main ------------------------------------------------------------------

async function main() {
  const app = await _electron.launch({
    executablePath: ELECTRON,
    args: [APP_DIR, `--user-data-dir=${USER_DATA_DIR}`],
    env: { ...process.env, VOLLI_DB_PATH: DB_PATH, VOLLI_SKIP_CLOSE_CONFIRM: "1" },
  });

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

    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    // ---- seed: one project, one ticket with the probe body -----------------
    await page.evaluate(
      ({ id, path, prefix }) => {
        localStorage.setItem(
          "volli:projects",
          JSON.stringify({
            state: {
              projects: [
                {
                  id,
                  name: "Live Preview Project",
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

    const seed = await page.evaluate(async (body) => {
      const boot = await window.api.data.bootstrap();
      if (!boot.ok) return { ok: false, error: `bootstrap: ${boot.error}` };
      const project = boot.data.projects[0];
      if (!project) return { ok: false, error: "no project after import" };
      const created = await window.api.tickets.create({
        projectId: project.id,
        status: "todo",
        title: "Live preview probe ticket",
        priority: "medium",
      });
      if (!created.ok) return { ok: false, error: `create: ${created.error}` };
      const updated = await window.api.tickets.update({ ticketId: created.ticket.id, body });
      if (!updated.ok) return { ok: false, error: `update: ${updated.error}` };
      return { ok: true };
    }, BODY);
    if (!seed.ok) throw new Error(`seed failed: ${seed.error}`);

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await waitUntil(
      "seeded card to render",
      async () => (await cardById(page, DISPLAY_ID).count()) === 1,
    );
    await cardById(page, DISPLAY_ID).dblclick();
    await waitUntil("detail view to open", async () => (await docTab(page).count()) === 1);
    await waitUntil(
      "body editor to render the seeded doc",
      async () => (await page.locator(".cm-line", { hasText: "First Heading" }).count()) >= 1,
    );

    // ===================================================================
    // 1. BLURRED MOUNT: the first line's `##` must be hidden even though
    //    the default CM selection (0,0) touches it.
    // ===================================================================
    await attempt(1, "Blurred mount: first-line heading shows no raw ##", async () => {
      const hidden = await waitUntil(
        "first heading to collapse",
        async () => {
          const text = await lineText(page, "First Heading");
          return text !== "" && !text.includes("#") ? text : null;
        },
        { timeout: 8000 },
      );
      return { ok: !!hidden, detail: `line=${JSON.stringify(hidden)}` };
    });

    // ===================================================================
    // 2. BLURRED MOUNT: no **/~~ delimiters visible anywhere in view.
    // ===================================================================
    await attempt(2, "Blurred mount: no **/~~ delimiters visible", async () => {
      const clean = await waitUntil(
        "emphasis delimiters to collapse",
        async () => {
          const text = await page.locator(".cm-content").innerText();
          return !text.includes("**") && !text.includes("~~") ? true : null;
        },
        { timeout: 8000 },
      );
      return { ok: !!clean, detail: "" };
    });

    // ===================================================================
    // 3. CARET REVEAL: clicking the heading line reveals its ## marks.
    // ===================================================================
    await attempt(3, "Focused caret on the heading line reveals ##", async () => {
      await page.locator(".cm-line", { hasText: "First Heading" }).first().click();
      const revealed = await waitUntil("heading marks to reveal", async () => {
        const text = await lineText(page, "First Heading");
        return text.includes("##") ? text : null;
      });
      return { ok: !!revealed, detail: `line=${JSON.stringify(revealed)}` };
    });

    // ===================================================================
    // 4. BLUR RE-COLLAPSES: clicking outside the editor hides ## again,
    //    even though the CM selection still touches that line.
    // ===================================================================
    await attempt(4, "Blur (click outside editor) re-collapses the caret line", async () => {
      await docTab(page).click();
      const hidden = await waitUntil("heading marks to re-collapse on blur", async () => {
        const text = await lineText(page, "First Heading");
        return text !== "" && !text.includes("#") ? text : null;
      });
      return { ok: !!hidden, detail: `line=${JSON.stringify(hidden)}` };
    });

    // ===================================================================
    // 5. BACKGROUND-PARSE CONVERGENCE: wheel-scroll (no clicks, no caret
    //    moves) to the deep tail heading; it must style as a heading with
    //    its ## hidden purely from parse/viewport updates.
    // ===================================================================
    await attempt(5, "Deep heading styles correctly after wheel-scroll only", async () => {
      // The editor grows to content height (the OUTER overflow-y div scrolls),
      // so clamp to the visible window — the box's center can be thousands of
      // px below the viewport, where wheel events land on nothing.
      const scroller = page.locator(".cm-scroller").first();
      const box = await scroller.boundingBox();
      if (!box) throw new Error("no scroller box");
      const viewport = page.viewportSize() ?? { height: 600 };
      const y = Math.min(box.y + box.height / 2, viewport.height - 100);
      await page.mouse.move(box.x + box.width / 2, Math.max(box.y + 10, y));
      const converged = await waitUntil(
        "tail heading to render collapsed + styled",
        async () => {
          await page.mouse.wheel(0, 4000);
          const line = page.locator(".cm-line", { hasText: TAIL_HEADING }).first();
          if ((await line.count()) === 0) return null;
          const text = (await line.textContent()) ?? "";
          const cls = (await line.getAttribute("class")) ?? "";
          return !text.includes("#") && cls.includes("cm-md-h2") ? `${cls}` : null;
        },
        { timeout: 15000, interval: 250 },
      );
      return { ok: !!converged, detail: `class=${JSON.stringify(converged)}` };
    });
  } finally {
    await app.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    failed.length === 0
      ? `\nlive-preview smoke: all ${results.length} checks passed`
      : `\nlive-preview smoke: ${failed.length}/${results.length} checks FAILED`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
