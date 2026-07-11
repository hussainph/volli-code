/**
 * End-to-end acceptance smoke for Volli's kanban board. Drives the REAL
 * packaged renderer through Playwright: seeds one project's demo tickets via
 * isolated localStorage, then exercises the board UI a user would touch — columns,
 * the collapsed-column rail, search, the priority facet, cross-column and
 * pill drag-and-drop, reload persistence, adding a card, and non-destructive
 * context-menu actions. Later checks (13+) cover the board's second-generation
 * surfaces: the Ordering dropdown, the board/list view toggle (list-view add +
 * drag parity), the sidebar's Active Sessions link, and the chrome-static UI
 * zoom (CSS `zoom` below the 40px chrome band, driven by a main-process IPC).
 *
 * Board state (`volli:board`, `volli:projects` in localStorage) is reset and
 * reseeded at startup, so reruns are deterministic — the 11-ticket demo seed
 * (`apps/desktop/src/renderer/src/lib/demo-tickets.ts`) always starts in the
 * same shape: Backlog 4, Todo 3, Doing 2, Needs Review 2, Done 0 (collapsed).
 *
 * This is a MANUALLY-RUN smoke (needs a display + the built app); it is NOT
 * wired into `vp test`.
 *
 *   Run:
 *     pnpm run build                        # produce dist/ + dist-electron/
 *     node apps/desktop/e2e/board-smoke.mjs
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
  process.env.VOLLI_SMOKE_DIR ?? (await fs.mkdtemp(join(os.tmpdir(), "volli-board-smoke-")));
const USER_DATA_DIR = join(SCRATCH, "user-data");
await fs.mkdir(USER_DATA_DIR, { recursive: true });

// ---- tiny test harness -----------------------------------------------------

const results = [];
/** Record a numbered PASS/FAIL line; never throws so later steps still run. */
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

// ---- board DOM helpers ------------------------------------------------------

/** A locator for the single `<article>` whose mono id span equals `id` exactly. */
function cardById(page, id) {
  const exact = new RegExp(`^${id}$`);
  return page
    .locator("article")
    .filter({ has: page.locator("span.font-mono", { hasText: exact }) });
}

/**
 * The number next to a column's header label (e.g. Backlog's "4"), read
 * straight from the DOM. Returns null while `label` is a collapsed rail pill
 * instead of a real column — a column body and its pill are never both
 * mounted (see board-dnd.ts's id-scheme comment), so this only matches the
 * expanded-column header row.
 */
async function columnCount(page, label) {
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

/** Expanded status labels, left to right. Collapsed rail pills return null from columnCount. */
async function expandedStatuses(page) {
  const labels = ["Backlog", "Todo", "Doing", "Needs Review", "Done"];
  const expanded = [];
  for (const label of labels) {
    if ((await columnCount(page, label)) !== null) expanded.push(label);
  }
  return expanded;
}

/** Drag from `sourceBox`'s centre to `target`, with enough travel for dnd-kit's PointerSensor (distance 4) to activate and dragOver to fire on the target. */
async function drag(page, sourceBox, target) {
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 30, sourceBox.y + 40, { steps: 8 });
  await page.mouse.move(target.x, target.y, { steps: 20 });
  await sleep(250);
  await page.mouse.up();
  await sleep(500);
}

/** Click the Board nav item if present (nav is remembered per-workspace and defaults to Board, but re-assert after every reload to be robust). */
async function goToBoard(page) {
  const boardNav = page.getByRole("button", { name: "Board", exact: true });
  if (await boardNav.count()) await boardNav.first().click();
  await sleep(500);
}

/**
 * The mono id of the FIRST card under a column header (board view) — the header
 * div is the same `flex items-center gap-2` node `columnCount` keys on, and its
 * parent is the column container, so we read the first `<article>`'s id span
 * from there. Lets the ordering checks assert on display order without guessing
 * pixel positions.
 */
async function firstCardIdInColumn(page, label) {
  return page.evaluate((columnLabel) => {
    const headers = Array.from(document.querySelectorAll("div.flex.items-center.gap-2"));
    const header = headers.find((div) => {
      const first = div.children[0];
      return first?.tagName === "SPAN" && first.textContent === columnLabel;
    });
    const article = header?.parentElement?.querySelector("article");
    return article?.querySelector("span.font-mono")?.textContent?.trim() ?? null;
  }, label);
}

/** Whether a board-view column (by header label) contains a card with mono id `id`. */
async function columnHasCard(page, label, id) {
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

/** The ticket ids listed in the sidebar's "Active Sessions" group, in DOM order. */
async function sidebarSessionIds(page) {
  return page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll('[data-sidebar="group"]'));
    const group = groups.find((g) =>
      Array.from(g.querySelectorAll('[data-sidebar="group-label"]')).some(
        (label) => label.textContent?.trim() === "Active Sessions",
      ),
    );
    if (!group) return null;
    return Array.from(group.querySelectorAll('[data-sidebar="menu-button"] span.font-mono')).map(
      (span) => span.textContent?.trim(),
    );
  });
}

// ---- main ------------------------------------------------------------------

async function main() {
  const app = await _electron.launch({
    executablePath: ELECTRON,
    args: [APP_DIR, `--user-data-dir=${USER_DATA_DIR}`],
  });

  try {
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

    // Seed one project + a fresh (unseeded) board, then reload so the demo
    // tickets regenerate from a clean boot — deterministic on every rerun.
    await page.evaluate((repo) => {
      localStorage.setItem(
        "volli:projects",
        JSON.stringify({
          state: {
            projects: [
              {
                id: "board-smoke-project",
                name: "Volli Code",
                path: repo,
                ticketPrefix: "VC",
                createdAt: Date.now(),
              },
            ],
            selectedProjectId: "board-smoke-project",
          },
          version: 1,
        }),
      );
      localStorage.removeItem("volli:board");
    }, REPO);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1500);
    await goToBoard(page);

    // === 1. All 5 status labels present (expanded columns or collapsed rail) ===
    await attempt(1, "Board renders: all 5 status labels present", async () => {
      const labels = ["Backlog", "Todo", "Doing", "Needs Review", "Done"];
      const counts = {};
      for (const label of labels) {
        counts[label] = await page.getByText(label, { exact: true }).count();
      }
      const ok = labels.every((label) => counts[label] >= 1);
      return { ok, detail: JSON.stringify(counts) };
    });

    // === 2. Demo seed: 11 cards, VC-1 present with its known title ===========
    await attempt(2, "Demo seed: 11 cards; VC-1 shows mono id + title", async () => {
      const count = await page.locator("article").count();
      const vc1 = cardById(page, "VC-1");
      const vc1Count = await vc1.count();
      const title = vc1Count === 1 ? (await vc1.locator("p").first().textContent())?.trim() : null;
      const ok = count === 11 && vc1Count === 1 && title === "Design SQLite ticket schema";
      return { ok, detail: `count=${count} vc1Count=${vc1Count} title=${JSON.stringify(title)}` };
    });

    // === 3. Collapsed rail: Empty caption + Done starts as a pill ============
    await attempt(
      3,
      'Collapsed rail: "Empty" caption present, Done is a pill (not a column)',
      async () => {
        const emptyCaption = await page.getByText("Empty", { exact: true }).count();
        const doneAsColumn = await columnCount(page, "Done");
        const donePillText = await page.getByText("Done", { exact: true }).count();
        const ok = emptyCaption >= 1 && doneAsColumn === null && donePillText >= 1;
        return {
          ok,
          detail: `empty=${emptyCaption} doneColumnCount=${doneAsColumn} donePillTextCount=${donePillText}`,
        };
      },
    );

    // === 4. Empty-column creation: clicking Done opens its composer ==========
    await attempt(
      4,
      "Collapsed pill: click opens Done's composer; Escape re-collapses it",
      async () => {
        await page.getByText("Done", { exact: true }).first().click();
        await sleep(250);
        const expandedCount = await columnCount(page, "Done");
        const composerCount = await page.getByPlaceholder("Ticket title…").count();
        await page.keyboard.press("Escape");
        await sleep(250);
        const collapsedCount = await columnCount(page, "Done");
        const ok = expandedCount === 0 && composerCount === 1 && collapsedCount === null;
        return {
          ok,
          detail: `expanded=${expandedCount} composer=${composerCount} afterEscape=${collapsedCount}`,
        };
      },
    );

    // === 5. Filtered drag freezes the visible column topology ================
    await attempt(
      5,
      "Filtered drag: starting a drag does not expand filtered-empty columns",
      async () => {
        const search = page.getByPlaceholder("Search tickets…");
        await search.fill("Design SQLite ticket schema");
        await sleep(300);
        const before = await expandedStatuses(page);
        const cardBox = await page.locator("article").first().boundingBox();
        if (!cardBox) throw new Error("filtered card not found");
        await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(cardBox.x + cardBox.width / 2 + 30, cardBox.y + 20, { steps: 8 });
        await sleep(250);
        const during = await expandedStatuses(page);
        await page.mouse.up();
        await search.fill("");
        await sleep(300);
        const ok = JSON.stringify(during) === JSON.stringify(before);
        return { ok, detail: `before=${JSON.stringify(before)} during=${JSON.stringify(during)}` };
      },
    );

    // === 6. Search filter: "ghostty" narrows to 1, clearing restores 11 =====
    await attempt(6, 'Search "ghostty" narrows to 1 card, clearing restores 11', async () => {
      const search = page.getByPlaceholder("Search tickets…");
      await search.click();
      await search.fill("ghostty");
      await sleep(400);
      const filtered = await page.locator("article").count();
      await search.fill("");
      await sleep(400);
      const restored = await page.locator("article").count();
      const ok = filtered === 1 && restored === 11;
      return { ok, detail: `filtered=${filtered} restored=${restored}` };
    });

    // === 7. Priority facet: toggling High narrows, toggling off restores ====
    await attempt(
      7,
      'Priority chip: toggling "High" narrows the board, toggling off restores',
      async () => {
        await page.getByRole("button", { name: "Priority", exact: true }).click();
        await sleep(200);
        const high = page.getByRole("menuitemcheckbox", { name: "High" });
        await high.click();
        await sleep(400);
        const filtered = await page.locator("article").count();
        // The checkbox item calls preventDefault on select, so the menu stays
        // open across toggles — no need to reopen it.
        await high.click();
        await page.keyboard.press("Escape");
        await sleep(400);
        const restored = await page.locator("article").count();
        const ok = filtered >= 1 && filtered < 11 && restored === 11;
        return { ok, detail: `filtered=${filtered} restored=${restored}` };
      },
    );

    // === 8. Cross-column drag: Backlog's first card into Doing's body =======
    await attempt(
      8,
      "Cross-column drag: first Backlog card into Doing decrements/increments counts",
      async () => {
        const before = {
          backlog: await columnCount(page, "Backlog"),
          doing: await columnCount(page, "Doing"),
        };
        const cardBox = await page.locator("article").first().boundingBox();
        const doingHeaderBox = await page.getByText("Doing", { exact: true }).first().boundingBox();
        if (!cardBox || !doingHeaderBox) throw new Error("card or Doing header not found");
        await drag(page, cardBox, { x: doingHeaderBox.x + 20, y: doingHeaderBox.y + 120 });
        const after = {
          backlog: await columnCount(page, "Backlog"),
          doing: await columnCount(page, "Doing"),
        };
        const ok =
          before.backlog !== null &&
          before.doing !== null &&
          after.backlog === before.backlog - 1 &&
          after.doing === before.doing + 1;
        return { ok, detail: `before=${JSON.stringify(before)} after=${JSON.stringify(after)}` };
      },
    );

    // === 9. Pill drop: dropping onto the Done pill expands it into a column =
    await attempt(
      9,
      'Pill drop: dragging onto the "Done" pill expands it into a column and clears "Empty"',
      async () => {
        const cardBox = await page.locator("article").first().boundingBox();
        const donePillBox = await page.getByText("Done", { exact: true }).first().boundingBox();
        if (!cardBox || !donePillBox) throw new Error("card or Done pill not found");
        await drag(page, cardBox, {
          x: donePillBox.x + donePillBox.width / 2,
          y: donePillBox.y + donePillBox.height / 2,
        });
        const doneCount = await columnCount(page, "Done");
        const emptyCaption = await page.getByText("Empty", { exact: true }).count();
        const ok = doneCount === 1 && emptyCaption === 0;
        return { ok, detail: `doneCount=${doneCount} emptyCaption=${emptyCaption}` };
      },
    );

    // === 10. Persistence: reload and confirm the moves survived ==============
    await attempt(10, "Persistence: reload keeps the Doing/Done moves", async () => {
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      await sleep(1500);
      await goToBoard(page);
      const doing = await columnCount(page, "Doing");
      const done = await columnCount(page, "Done");
      const ok = doing === 3 && done === 1;
      return { ok, detail: `doing=${doing} done=${done}` };
    });

    // === 11. Add-card: Backlog's "+ New" composer creates VC-12 ==============
    await attempt(
      11,
      '"+ New" composer: Enter submits a card, Escape closes it, VC-12 appears',
      async () => {
        const before = await page.locator("article").count();
        await page.getByRole("button", { name: "New", exact: true }).first().click();
        await sleep(200);
        await page.getByPlaceholder("Ticket title…").fill("Board smoke test card");
        await page.keyboard.press("Enter");
        await sleep(400);
        await page.keyboard.press("Escape");
        await sleep(300);
        const after = await page.locator("article").count();
        const vc12 = cardById(page, "VC-12");
        const vc12Count = await vc12.count();
        const ok = after === before + 1 && vc12Count === 1;
        return { ok, detail: `before=${before} after=${after} vc12Count=${vc12Count}` };
      },
    );

    // === 12. Context menu has no destructive board-level action ==============
    await attempt(12, "Context menu: ticket actions are non-destructive", async () => {
      const vc12 = cardById(page, "VC-12");
      await vc12.click({ button: "right" });
      await sleep(300);
      const moveTo = await page.getByRole("menuitem", { name: "Move to", exact: true }).count();
      const priority = await page.getByRole("menuitem", { name: "Priority", exact: true }).count();
      const destructive = await page.getByRole("menuitem", { name: "Delete", exact: true }).count();
      await page.keyboard.press("Escape");
      const ok = moveTo === 1 && priority === 1 && destructive === 0;
      return { ok, detail: `moveTo=${moveTo} priority=${priority} delete=${destructive}` };
    });

    // Board state entering the second-generation surface checks (verified from
    // the run above): Backlog 3 [VC-3, VC-4, VC-12], Todo 3 [VC-5, VC-6, VC-7],
    // Doing 3, Needs Review 2, Done 1 — 12 tickets. Todo is untouched by every
    // drag so far, so its manual order is still the seed order (VC-5, VC-6,
    // VC-7) and VC-6 ("Harden terminal engine reconnect") is its lone High.

    // The Ordering chip lives in the header's right-side cluster (`ml-auto`);
    // scoping to it disambiguates from the FilterBar's "Priority" facet button,
    // which shares the chip's label once Priority ordering is picked.
    const orderingChip = page.locator("div.ml-auto.shrink-0 button").first();

    // === 13. Ordering: Priority re-sorts a column, Manual restores it ========
    await attempt(
      13,
      'Ordering dropdown: "Priority" floats Todo\'s High card up; "Manual" restores seed order',
      async () => {
        const manualFirst = await firstCardIdInColumn(page, "Todo");
        await orderingChip.click();
        await sleep(200);
        await page.getByRole("menuitemradio", { name: "Priority", exact: true }).click();
        await sleep(300);
        const priorityFirst = await firstCardIdInColumn(page, "Todo");
        await orderingChip.click();
        await sleep(200);
        await page.getByRole("menuitemradio", { name: "Manual", exact: true }).click();
        await sleep(300);
        const restoredFirst = await firstCardIdInColumn(page, "Todo");
        const ok = manualFirst === "VC-5" && priorityFirst === "VC-6" && restoredFirst === "VC-5";
        return {
          ok,
          detail: `manual=${manualFirst} priority=${priorityFirst} restored=${restoredFirst}`,
        };
      },
    );

    // === 14. View toggle: List view renders status sections + id rows ========
    await attempt(
      14,
      "List view: section headers carry correct counts and tickets render as rows",
      async () => {
        await page.getByRole("button", { name: "List view", exact: true }).click();
        await sleep(400);
        const counts = {
          Backlog: await columnCount(page, "Backlog"),
          Todo: await columnCount(page, "Todo"),
          Doing: await columnCount(page, "Doing"),
          "Needs Review": await columnCount(page, "Needs Review"),
          Done: await columnCount(page, "Done"),
        };
        // Rows are divs, not <article> — the list view mounts none.
        const articleCount = await page.locator("article").count();
        const rowCount = await page.locator("[data-ticket-row]").count();
        const vc5Row = await page.locator('[data-ticket-id="VC-5"]').count();
        const ok =
          counts.Backlog === 3 &&
          counts.Todo === 3 &&
          counts.Doing === 3 &&
          counts["Needs Review"] === 2 &&
          counts.Done === 1 &&
          articleCount === 0 &&
          rowCount === 12 &&
          vc5Row === 1;
        return {
          ok,
          detail: `counts=${JSON.stringify(counts)} articles=${articleCount} rows=${rowCount} vc5Row=${vc5Row}`,
        };
      },
    );

    // === 15. List-view add: a section composer creates a row ==================
    await attempt(
      15,
      'List view "+ New": Enter submits VC-13 as a row, Escape closes the composer',
      async () => {
        const before = await page.locator("[data-ticket-row]").count();
        await page.getByRole("button", { name: "New", exact: true }).first().click();
        await sleep(200);
        await page.getByPlaceholder("Ticket title…").fill("List view smoke card");
        await page.keyboard.press("Enter");
        await sleep(400);
        await page.keyboard.press("Escape");
        await sleep(300);
        const after = await page.locator("[data-ticket-row]").count();
        const vc13Row = await page.locator('[data-ticket-id="VC-13"]').count();
        const composerOpen = await page.getByPlaceholder("Ticket title…").count();
        const ok = after === before + 1 && vc13Row === 1 && composerOpen === 0;
        return {
          ok,
          detail: `before=${before} after=${after} vc13Row=${vc13Row} composer=${composerOpen}`,
        };
      },
    );

    // === 16. List-view drag: a row crosses sections and the move persists =====
    await attempt(
      16,
      "List view drag: dragging VC-5 from Todo into Backlog moves it and survives reload",
      async () => {
        const beforeTodo = await columnCount(page, "Todo");
        const beforeBacklog = await columnCount(page, "Backlog");
        const sourceBox = await page.locator('[data-ticket-id="VC-5"]').boundingBox();
        // Target the last Backlog row (VC-13, just added) — nearest to VC-5's
        // origin and clear of Backlog's sticky header.
        const targetBox = await page.locator('[data-ticket-id="VC-13"]').boundingBox();
        if (!sourceBox || !targetBox) throw new Error("list rows not found");
        await drag(page, sourceBox, {
          x: targetBox.x + targetBox.width / 2,
          y: targetBox.y + targetBox.height / 2,
        });
        const afterTodo = await columnCount(page, "Todo");
        const afterBacklog = await columnCount(page, "Backlog");
        // Persist: reload drops back to the default board view (view/sort are
        // session-only); the ticket move lives in the persisted board store.
        await page.reload();
        await page.waitForLoadState("domcontentloaded");
        await sleep(1500);
        await goToBoard(page);
        const persistedTodo = await columnCount(page, "Todo");
        const persistedBacklog = await columnCount(page, "Backlog");
        const vc5InBacklog = await columnHasCard(page, "Backlog", "VC-5");
        const ok =
          afterTodo === beforeTodo - 1 &&
          afterBacklog === beforeBacklog + 1 &&
          persistedTodo === beforeTodo - 1 &&
          persistedBacklog === beforeBacklog + 1 &&
          vc5InBacklog;
        return {
          ok,
          detail: `todo ${beforeTodo}->${afterTodo} (persist ${persistedTodo}) backlog ${beforeBacklog}->${afterBacklog} (persist ${persistedBacklog}) vc5InBacklog=${vc5InBacklog}`,
        };
      },
    );

    // === 17. Sidebar Active Sessions link jumps to the board with selection ===
    await attempt(
      17,
      "Sidebar Active Sessions lists doing+needs_review ids; clicking one selects its card",
      async () => {
        const ids = await sidebarSessionIds(page);
        const expectedIds = ["VC-1", "VC-8", "VC-9", "VC-10", "VC-11"];
        const idsMatch =
          Array.isArray(ids) &&
          ids.length === expectedIds.length &&
          expectedIds.every((id) => ids.includes(id));
        // Click VC-1's session row (scoped to the sidebar menu button so it can't
        // hit the board card that shares the id).
        await page
          .locator('[data-sidebar="menu-button"]')
          .filter({ has: page.locator("span.font-mono", { hasText: /^VC-1$/ }) })
          .first()
          .click();
        await sleep(400);
        const card = cardById(page, "VC-1");
        const onBoard = (await card.count()) === 1;
        const cardClass = onBoard ? ((await card.getAttribute("class")) ?? "") : "";
        const selected = cardClass.includes("border-primary/70");
        const ok = idsMatch && onBoard && selected;
        return { ok, detail: `ids=${JSON.stringify(ids)} onBoard=${onBoard} selected=${selected}` };
      },
    );

    // === 18. Chrome-static UI zoom: content scales, the chrome band doesn't ===
    await attempt(
      18,
      "UI zoom command scales content (~1.1x) while the 40px chrome band stays put; reset restores",
      async () => {
        const band = page.locator(".app-region-drag").first();
        const content = cardById(page, "VC-8");
        const bandBefore = await band.boundingBox();
        const contentBefore = await content.boundingBox();
        if (!bandBefore || !contentBefore) throw new Error("band or content card not found");

        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].webContents.send("volli:ui-zoom-command", "in"),
        );
        await sleep(400);
        const bandZoomed = await band.boundingBox();
        const contentZoomed = await content.boundingBox();
        const persistedScale = await page.evaluate(() => {
          const raw = localStorage.getItem("volli:ui");
          return raw ? JSON.parse(raw).state?.uiScale : null;
        });

        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].webContents.send("volli:ui-zoom-command", "reset"),
        );
        await sleep(400);
        const bandReset = await band.boundingBox();
        const contentReset = await content.boundingBox();
        if (!bandZoomed || !contentZoomed || !bandReset || !contentReset) {
          throw new Error("missing box after zoom");
        }

        const bandStable =
          Math.abs(bandBefore.height - 40) < 1 &&
          Math.abs(bandZoomed.height - 40) < 1 &&
          Math.abs(bandReset.height - 40) < 1;
        const growth = contentZoomed.height / contentBefore.height;
        const grew = growth > 1.07 && growth < 1.13;
        const restored = Math.abs(contentReset.height - contentBefore.height) < 1;
        const ok = bandStable && grew && restored && persistedScale === 1.1;
        return {
          ok,
          detail: `band=${bandBefore.height.toFixed(1)}/${bandZoomed.height.toFixed(1)}/${bandReset.height.toFixed(1)} growth=${growth.toFixed(3)} persisted=${persistedScale} restored=${restored}`,
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
