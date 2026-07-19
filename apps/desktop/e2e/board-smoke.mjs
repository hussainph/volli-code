/**
 * End-to-end acceptance smoke for Volli's kanban board — reworked for the
 * SQLite persistence migration (docs/CONCEPT.md decision #29). Drives the REAL
 * packaged renderer through Playwright against a scratch SQLite database
 * (`VOLLI_DB_PATH`, passed via the Electron process env), exercising the whole
 * new boot/import/durability path a user would hit:
 *
 *   0. First-run empty state — assert the neutral textured project canvas has
 *      one clear import action and no duplicate sidebar prompt.
 *   A. First-boot legacy import — seed the OLD `volli:projects` localStorage
 *      envelope + a junk `volli:board` key, reload, and assert the project is
 *      imported into SQLite, the board starts EMPTY (the demo seed is gone),
 *      and every `volli:*` localStorage key is cleared.
 *   B. Fixture seeding through the preload bridge — resolve the imported
 *      project via `window.api.data.bootstrap()`, create the 11 tickets of the
 *      retired demo distribution via `window.api.tickets.create`, attach
 *      labels to three via `tickets.setLabels`, then reload (the board store
 *      hydrates at boot) and assert they render.
 *   C. The board UI a user touches — collapsed-column rail, search, the
 *      priority + label facets, cross-column and pill drag-and-drop, the
 *      column composer, the non-destructive context menu, priority mutation
 *      reconcile + persistence, the Ordering dropdown, the board/list view
 *      toggle (list-view add + drag parity),
 *      the sidebar's Active Sessions, the chrome-static UI zoom (uiScale now
 *      read back from SQLite `app_state`, not localStorage), and the global
 *      New-ticket dialog ("c" hotkey, chrome-search guard, header button),
 *      plus the persisted workspace-switcher visibility toggle.
 *   D. DURABILITY — capture the full board state, `electronApp.close()`, then
 *      relaunch a fresh Electron process against the SAME `VOLLI_DB_PATH` and
 *      assert the board survived (SQLite, not localStorage — the relaunch's
 *      localStorage still has no `volli:*` keys).
 *   E. Boot-failure path — launch once with `VOLLI_DB_PATH` under an
 *      unwritable parent (a FILE) and assert the "Volli couldn't load its
 *      data" panel renders.
 *
 * All domain data now lives in SQLite; there is no demo seed and no
 * `volli:board` persistence. Display ids ("VC-5") are derived from the
 * project prefix + a per-project ticket number; `data-ticket-id` attributes
 * carry the display id, dnd internals use the opaque ticket UUID.
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

import { waitUntil } from "./lib/smoke-kit.mjs";

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
// Optional visual-review artifact for the zero-project state. Kept opt-in so
// normal smoke runs stay artifact-free.
const FIRST_RUN_CAPTURE_PATH = process.env.VOLLI_SMOKE_CAPTURE_FIRST_RUN;
const USER_DATA_DIR = join(SCRATCH, "user-data");
// The scratch SQLite database, handed to main via VOLLI_DB_PATH. Lives inside
// the profile dir so `ownsScratch` cleanup removes it too. Survives a renderer
// reload AND a full Electron relaunch — that persistence is what phase D tests.
const DB_PATH = join(SCRATCH, "volli.db");
await fs.mkdir(USER_DATA_DIR, { recursive: true });

// ---- the 11-ticket fixture, recovered from the retired demo-tickets.ts -----
//
// Created in this order so the per-project ticket_number (COALESCE(MAX)+1)
// assigns VC-1..VC-11 exactly as the old demo did: Backlog 4, Todo 3, Doing 2,
// Needs Review 2, Done 0. Statuses/priorities/titles mirror the old DEMO seed.
const FIXTURE_TICKETS = [
  { title: "Design SQLite ticket schema", status: "backlog", priority: "low" }, // VC-1
  { title: "Prototype worktree archive flow", status: "backlog", priority: "medium" }, // VC-2
  { title: "Spike: volli CLI socket handshake", status: "backlog", priority: "high" }, // VC-3
  { title: "Sketch board column drag affordance", status: "backlog", priority: "low" }, // VC-4
  { title: "Wire native notifications for ticket moves", status: "todo", priority: "medium" }, // VC-5
  { title: "Harden terminal engine reconnect", status: "todo", priority: "high" }, // VC-6
  { title: "Add opencode harness adapter", status: "todo", priority: "medium" }, // VC-7
  { title: "Implement worktree-per-ticket boot", status: "doing", priority: "high" }, // VC-8
  { title: "Fix ghostty config Cmd+Opt+arrow nav", status: "doing", priority: "medium" }, // VC-9
  { title: "Polish board card hover states", status: "needs_review", priority: "low" }, // VC-10
  { title: "Restty GPU device-loss recovery", status: "needs_review", priority: "high" }, // VC-11
];
// Labels on three tickets (mirroring the old demo tags). "board" lands on VC-1
// only, giving the label facet a single-card narrow to assert on.
const FIXTURE_LABELS = {
  "Design SQLite ticket schema": ["board", "infra"], // VC-1
  "Harden terminal engine reconnect": ["terminal", "bug"], // VC-6
  "Implement worktree-per-ticket boot": ["agent", "infra"], // VC-8
};

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

// ---- launch ----------------------------------------------------------------

/**
 * Launch the built app with `VOLLI_DB_PATH` (and the isolated user-data dir)
 * injected via the Electron process env — merged over `process.env` so the
 * child keeps PATH etc. Returns the ElectronApplication; callers grab
 * `firstWindow()` themselves.
 */
function launch(dbPath) {
  return _electron.launch({
    executablePath: ELECTRON,
    args: [APP_DIR, `--user-data-dir=${USER_DATA_DIR}`],
    env: { ...process.env, VOLLI_DB_PATH: dbPath },
  });
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
 * expanded-column header row (works in both board and list views).
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

/**
 * The ordered display ids under each expanded board-view column, keyed by
 * status label (null for a collapsed pill). The full board fingerprint the
 * durability check captures before close and re-reads after relaunch.
 */
async function boardStateByColumn(page) {
  return page.evaluate(() => {
    const labels = ["Backlog", "Todo", "Doing", "Needs Review", "Done"];
    const headers = Array.from(document.querySelectorAll("div.flex.items-center.gap-2"));
    const state = {};
    for (const label of labels) {
      const header = headers.find((div) => {
        const first = div.children[0];
        return first?.tagName === "SPAN" && first.textContent === label;
      });
      if (!header) {
        state[label] = null; // collapsed pill
        continue;
      }
      state[label] = Array.from(
        header.parentElement?.querySelectorAll("article span.font-mono") ?? [],
      ).map((span) => span.textContent?.trim());
    }
    return state;
  });
}

/** Every `volli:*` key currently in the page's localStorage (should be empty post-boot). */
async function volliLocalStorageKeys(page) {
  return page.evaluate(() => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null && key.startsWith("volli:")) keys.push(key);
    }
    return keys;
  });
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
  let app = await launch(DB_PATH);

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

    let page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    if (FIRST_RUN_CAPTURE_PATH) await page.screenshot({ path: FIRST_RUN_CAPTURE_PATH });

    // ===================================================================
    // PHASE 0 — first-run empty project canvas
    // ===================================================================
    await attempt(
      0,
      "Fresh profile: one textured project-start canvas with a display heading and text-only action",
      async () => {
        const state = page.locator("[data-empty-projects-state]");
        const primaryAction = page.getByRole("button", { name: "Add Project…", exact: true });
        const heading = page.getByRole("heading", { name: "Add your first project", exact: true });
        const oldSidebarPrompt = page.getByText("Add a project to get started", { exact: true });
        const oldSidebarHeader = page.getByText("No project selected", { exact: true });
        const texture = await state.evaluate((element) => {
          const canvas = getComputedStyle(element).backgroundImage;
          const dots = getComputedStyle(element, "::before").backgroundImage;
          return { canvas, dots };
        });
        const headingSize = await heading.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).fontSize),
        );

        const ok =
          (await state.count()) === 1 &&
          (await primaryAction.count()) === 1 &&
          (await primaryAction.locator("svg").count()) === 0 &&
          // text-title (24px) — the app's largest step since the type-scale
          // language landed (DESIGN.md); the old >=32 display size is gone.
          headingSize >= 24 &&
          (await oldSidebarPrompt.count()) === 0 &&
          (await oldSidebarHeader.count()) === 0 &&
          texture.canvas !== "none" &&
          texture.dots !== "none";
        return {
          ok,
          detail: `state=${await state.count()} primaryAction=${await primaryAction.count()} actionIcons=${await primaryAction.locator("svg").count()} headingSize=${headingSize}px oldPrompt=${await oldSidebarPrompt.count()} oldHeader=${await oldSidebarHeader.count()} texture=${JSON.stringify(texture)}`,
        };
      },
    );

    // ===================================================================
    // PHASE A — first-boot legacy import (localStorage → SQLite)
    // ===================================================================
    // Seed the OLD zustand `volli:projects` envelope exactly as the pre-SQLite
    // app persisted it (a readable project id — the import PRESERVES it), plus
    // a junk `volli:board` key (decision #29 discards the demo board). Then
    // reload so boot()'s first-run import fires against the empty scratch DB.
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
                colorIndex: 0,
                createdAt: Date.now(),
              },
            ],
            selectedProjectId: "board-smoke-project",
          },
          version: 1,
        }),
      );
      localStorage.setItem("volli:board", '{"state":{"junk":true},"version":1}');
    }, REPO);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1500);
    await goToBoard(page);

    // === 1. First boot imports the project; board starts EMPTY; storage cleared
    await attempt(
      1,
      "First-boot import: project in rail, board EMPTY (demo gone), volli:* localStorage cleared",
      async () => {
        const projectName = await page.getByText("Volli Code", { exact: true }).count();
        const statusLabels = ["Backlog", "Todo", "Doing", "Needs Review", "Done"];
        const labelsPresent = {};
        for (const label of statusLabels) {
          labelsPresent[label] = await page.getByText(label, { exact: true }).count();
        }
        const cardCount = await page.locator("article").count();
        const emptyCaption = await page.getByText("Empty", { exact: true }).count();
        const volliKeys = await volliLocalStorageKeys(page);
        const ok =
          projectName >= 1 &&
          statusLabels.every((label) => labelsPresent[label] >= 1) &&
          cardCount === 0 &&
          emptyCaption >= 1 &&
          volliKeys.length === 0;
        return {
          ok,
          detail: `project=${projectName} cards=${cardCount} empty=${emptyCaption} volliKeys=${JSON.stringify(volliKeys)} labels=${JSON.stringify(labelsPresent)}`,
        };
      },
    );

    // ===================================================================
    // PHASE B — seed the 11-ticket fixture through the preload bridge
    // ===================================================================
    // Resolve the imported project via bootstrap, create the fixture in order
    // (so ticket_number → VC-1..VC-11), attach labels to three, then reload so
    // the hydrate-at-boot board store picks them up.
    await attempt(
      2,
      "Bridge seed + reload: 11 cards render; VC-1 shows mono id + title; column counts match demo",
      async () => {
        const seedResult = await page.evaluate(
          async ({ tickets, labels }) => {
            const boot = await window.api.data.bootstrap();
            if (!boot.ok) return { ok: false, error: `bootstrap: ${boot.error}` };
            const project = boot.data.projects[0];
            if (!project) return { ok: false, error: "no project after import" };
            const idByTitle = {};
            for (const t of tickets) {
              const res = await window.api.tickets.create({
                projectId: project.id,
                status: t.status,
                title: t.title,
                priority: t.priority,
              });
              if (!res.ok) return { ok: false, error: `create ${t.title}: ${res.error}` };
              idByTitle[t.title] = res.ticket.id;
            }
            for (const [title, names] of Object.entries(labels)) {
              const res = await window.api.tickets.setLabels({
                ticketId: idByTitle[title],
                labels: names,
              });
              if (!res.ok) return { ok: false, error: `setLabels ${title}: ${res.error}` };
            }
            return { ok: true, projectId: project.id, created: Object.keys(idByTitle).length };
          },
          { tickets: FIXTURE_TICKETS, labels: FIXTURE_LABELS },
        );
        if (!seedResult.ok) throw new Error(seedResult.error);

        await page.reload();
        await page.waitForLoadState("domcontentloaded");
        await sleep(1500);
        await goToBoard(page);

        const count = await page.locator("article").count();
        const vc1 = cardById(page, "VC-1");
        const vc1Count = await vc1.count();
        const title =
          vc1Count === 1 ? (await vc1.locator("p").first().textContent())?.trim() : null;
        const counts = {
          backlog: await columnCount(page, "Backlog"),
          todo: await columnCount(page, "Todo"),
          doing: await columnCount(page, "Doing"),
          needsReview: await columnCount(page, "Needs Review"),
        };
        const ok =
          count === 11 &&
          vc1Count === 1 &&
          title === "Design SQLite ticket schema" &&
          counts.backlog === 4 &&
          counts.todo === 3 &&
          counts.doing === 2 &&
          counts.needsReview === 2;
        return {
          ok,
          detail: `seeded=${seedResult.created} count=${count} vc1=${JSON.stringify(title)} counts=${JSON.stringify(counts)}`,
        };
      },
    );

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

    // === 5. Universal command palette: ticket lookup opens its destination ===
    await attempt(5, "⌘K searches all tickets and opens the selected destination", async () => {
      const trigger = page.getByRole("button", { name: "Search tickets and sessions" });
      const signifier = (await trigger.textContent())?.includes("⌘K") ?? false;
      await page.keyboard.press("Meta+K");
      const search = page.getByPlaceholder("Search tickets and sessions…");
      await search.waitFor();
      await search.fill("ghostty");
      const result = page
        .getByRole("dialog")
        .getByText("Fix ghostty config Cmd+Opt+arrow nav", { exact: true });
      await result.waitFor();
      await result.click();
      await sleep(400);
      const opened = (await page.getByRole("tab", { name: "VC-9", exact: true }).count()) === 1;
      const paletteClosed = (await search.count()) === 0;
      await page.keyboard.press("Escape");
      await sleep(300);
      const boardRestored = (await page.locator("article").count()) === 11;
      const ok = signifier && opened && paletteClosed && boardRestored;
      return {
        ok,
        detail: `signifier=${signifier} opened=${opened} paletteClosed=${paletteClosed} boardRestored=${boardRestored}`,
      };
    });

    // === 6. Priority facet: toggling High narrows, toggling off restores ====
    await attempt(
      6,
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

    // === 7. Label facet: toggling a seeded label narrows, toggling off restores
    await attempt(
      7,
      'Label chip: toggling "board" narrows to its 1 card, toggling off restores 11',
      async () => {
        await page.getByRole("button", { name: "Label", exact: true }).click();
        await sleep(200);
        const boardLabel = page.getByRole("menuitemcheckbox", { name: "board", exact: true });
        await boardLabel.click();
        await sleep(400);
        const filtered = await page.locator("article").count();
        await boardLabel.click();
        await page.keyboard.press("Escape");
        await sleep(400);
        const restored = await page.locator("article").count();
        const ok = filtered === 1 && restored === 11;
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
        const donePill = page
          .getByRole("button")
          .filter({ has: page.getByText("Done", { exact: true }) })
          .first();

        let dropped = false;
        for (let dropAttempt = 1; dropAttempt <= 3 && !dropped; dropAttempt += 1) {
          const card = page.locator("article").first();
          await card.scrollIntoViewIfNeeded();
          const cardBox = await card.boundingBox();
          if (!cardBox) throw new Error("source card not found");

          // On smaller hosted-runner displays the collapsed rail can begin
          // outside the horizontal viewport. Activate the drag first (freezing
          // the board topology), scroll the live droppable into view while the
          // pointer is held, then wait until dnd-kit reports the actual isOver
          // state before releasing.
          await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
          await page.mouse.down();
          let targetActive = false;
          try {
            await page.mouse.move(cardBox.x + cardBox.width / 2 + 30, cardBox.y + 40, {
              steps: 8,
            });
            await donePill.scrollIntoViewIfNeeded();
            const donePillBox = await donePill.boundingBox();
            if (!donePillBox) throw new Error("Done pill not found");
            await page.mouse.move(
              donePillBox.x + donePillBox.width / 2,
              donePillBox.y + donePillBox.height / 2,
              { steps: 20 },
            );
            targetActive = await waitUntil(
              `Done pill hover attempt ${dropAttempt}`,
              () => donePill.evaluate((element) => element.className.includes("ring-primary")),
              { timeout: 2500 },
            )
              .then(() => true)
              .catch(() => false);
          } finally {
            await page.mouse.up();
          }
          await sleep(500);

          if (!targetActive) continue;
          dropped = await waitUntil(
            `Done pill drop attempt ${dropAttempt}`,
            async () =>
              (await columnCount(page, "Done")) === 1 &&
              (await page.getByText("Empty", { exact: true }).count()) === 0,
            { timeout: 2500 },
          )
            .then(() => true)
            .catch(() => false);
        }

        const doneCount = await columnCount(page, "Done");
        const emptyCaption = await page.getByText("Empty", { exact: true }).count();
        const ok = dropped && doneCount === 1 && emptyCaption === 0;
        return { ok, detail: `doneCount=${doneCount} emptyCaption=${emptyCaption}` };
      },
    );

    // === 10. Add-card: Backlog's "+ New" composer creates VC-12 =============
    await attempt(
      10,
      '"+ New" composer: Enter submits a card, Escape closes it, VC-12 appears (numbering continues)',
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

    // === 11. Context menu actions have icons and stay non-destructive =========
    await attempt(11, "Context menu: every ticket action has an icon", async () => {
      const vc12 = cardById(page, "VC-12");
      await vc12.click({ button: "right" });
      await sleep(300);
      const moveTo = page.getByRole("menuitem", { name: "Move to", exact: true });
      const priority = page.getByRole("menuitem", { name: "Priority", exact: true });
      const rootItems = page.locator('[data-slot="context-menu-content"] > [role="menuitem"]');
      const rootCount = await rootItems.count();
      const rootRowsWithIcons = await rootItems.evaluateAll(
        (items) => items.filter((item) => item.querySelector(":scope > svg") !== null).length,
      );

      await moveTo.hover();
      await page.getByRole("menuitem", { name: "Todo", exact: true }).waitFor();
      const moveItems = page.locator(
        '[data-slot="context-menu-sub-content"]:visible > [role="menuitem"]',
      );
      const moveCount = await moveItems.count();
      const moveRowsWithIcons = await moveItems.evaluateAll(
        (items) => items.filter((item) => item.querySelector(":scope > svg") !== null).length,
      );

      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await vc12.click({ button: "right" });
      await sleep(300);
      await priority.hover();
      await page.getByRole("menuitem", { name: "Low", exact: true }).waitFor();
      const priorityItems = page.locator(
        '[data-slot="context-menu-sub-content"]:visible > [role="menuitem"]',
      );
      const priorityCount = await priorityItems.count();
      const priorityRowsWithIcons = await priorityItems.evaluateAll(
        (items) => items.filter((item) => item.querySelector(":scope > svg") !== null).length,
      );
      const destructive = await page.getByRole("menuitem", { name: "Delete", exact: true }).count();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      const ok =
        rootCount === 3 &&
        rootRowsWithIcons === rootCount &&
        moveCount === 4 &&
        moveRowsWithIcons === moveCount &&
        priorityCount === 3 &&
        priorityRowsWithIcons === priorityCount &&
        destructive === 0;
      return {
        ok,
        detail: `root=${rootRowsWithIcons}/${rootCount} move=${moveRowsWithIcons}/${moveCount} priority=${priorityRowsWithIcons}/${priorityCount} delete=${destructive}`,
      };
    });

    // === 11.5. Priority mutation reconciles immediately and survives reload =
    await attempt(
      11.5,
      "Priority context action: indicator updates immediately and survives reload",
      async () => {
        const before = await cardById(page, "VC-12")
          .locator('[role="img"][aria-label^="Priority:"]')
          .getAttribute("aria-label");

        await cardById(page, "VC-12").click({ button: "right" });
        await sleep(300);
        await page.getByRole("menuitem", { name: "Priority", exact: true }).hover();
        await page.getByRole("menuitem", { name: "High", exact: true }).click();
        await sleep(400);

        const afterMutation = await cardById(page, "VC-12")
          .getByRole("img", { name: "Priority: High", exact: true })
          .count();

        await page.reload();
        await page.waitForLoadState("domcontentloaded");
        await sleep(1500);
        await goToBoard(page);

        const afterReload = await cardById(page, "VC-12")
          .getByRole("img", { name: "Priority: High", exact: true })
          .count();
        const ok =
          before !== null &&
          before !== "Priority: High" &&
          afterMutation === 1 &&
          afterReload === 1;
        return {
          ok,
          detail: `before=${JSON.stringify(before)} highAfterMutation=${afterMutation} highAfterReload=${afterReload}`,
        };
      },
    );

    // Board state entering the second-generation surface checks: Backlog 3
    // [VC-3, VC-4, VC-12], Todo 3 [VC-5, VC-6, VC-7], Doing 3, Needs Review 2,
    // Done 1 — 12 tickets. Todo is untouched by every drag so far, so its
    // manual order is still the seed order (VC-5, VC-6, VC-7) and VC-6 ("Harden
    // terminal engine reconnect") is its lone High.

    // The Ordering chip lives in the header's right-side cluster (`ml-auto`);
    // scoping to it disambiguates from the FilterBar's "Priority" facet button,
    // which shares the chip's label once Priority ordering is picked.
    const orderingChip = page.locator("div.ml-auto.shrink-0 button").first();

    // === 12. Ordering: Priority re-sorts a column, Manual restores it =======
    await attempt(
      12,
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

    // === 13. View toggle: List view renders status sections + id rows =======
    await attempt(
      13,
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

    // === 14. List-view add: a section composer creates a row ================
    await attempt(
      14,
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

    // === 15. List-view drag: a row crosses sections and the move persists ====
    await attempt(
      15,
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
        // Persist: the ticket move lives in SQLite, AND the list view itself
        // survives the reload (boardView persists per project via app_state) —
        // assert both, then switch back to Board view for the checks that follow.
        await page.reload();
        await page.waitForLoadState("domcontentloaded");
        await sleep(1500);
        await goToBoard(page);
        const listViewPersisted = (await page.locator("[data-ticket-row]").count()) > 0;
        const persistedTodo = await columnCount(page, "Todo");
        const persistedBacklog = await columnCount(page, "Backlog");
        const vc5InListBacklog =
          (await page
            .locator('[data-list-section][data-status="backlog"] [data-ticket-id="VC-5"]')
            .count()) === 1;
        await page.getByRole("button", { name: "Board view", exact: true }).click();
        await sleep(300);
        const vc5InBacklog = await columnHasCard(page, "Backlog", "VC-5");
        const ok =
          afterTodo === beforeTodo - 1 &&
          afterBacklog === beforeBacklog + 1 &&
          persistedTodo === beforeTodo - 1 &&
          persistedBacklog === beforeBacklog + 1 &&
          listViewPersisted &&
          vc5InListBacklog &&
          vc5InBacklog;
        return {
          ok,
          detail: `todo ${beforeTodo}->${afterTodo} (persist ${persistedTodo}) backlog ${beforeBacklog}->${afterBacklog} (persist ${persistedBacklog}) listViewPersisted=${listViewPersisted} vc5InBacklog=${vc5InBacklog}`,
        };
      },
    );

    // === 16. Sidebar attention tier is truthful without a live terminal =====
    await attempt(
      16,
      "Active Sessions promotes Needs Review tickets to Needs you without inventing live sessions",
      async () => {
        const ids = await sidebarSessionIds(page);
        const expectedIds = ["VC-10", "VC-11"];
        const idsMatch =
          Array.isArray(ids) &&
          ids.length === expectedIds.length &&
          expectedIds.every((id) => ids.includes(id));
        const needsYou = (await page.getByText("Needs you", { exact: true }).count()) === 1;
        const noInProgress = (await page.getByText("In progress", { exact: true }).count()) === 0;
        const needsYouRow = page
          .locator('[data-sidebar="menu-button"]')
          .filter({ has: page.locator("span.font-mono", { hasText: /^VC-10$/ }) })
          .first();
        const subtextBefore = await needsYouRow
          .locator(".session-row-meta")
          .evaluate((element) => getComputedStyle(element).color);
        await needsYouRow.click();
        await sleep(400);
        const ticketOpened =
          (await page.getByRole("tab", { name: "VC-10", exact: true }).count()) === 1;
        const subtextHighlight = await needsYouRow.evaluate((button) => {
          const subtext = button.querySelector(".session-row-meta");
          if (!(subtext instanceof HTMLElement)) return null;
          return {
            active: button.getAttribute("data-active"),
            buttonColor: getComputedStyle(button).color,
            subtextColor: getComputedStyle(subtext).color,
          };
        });
        const subtextHighlighted =
          subtextHighlight?.active === "true" &&
          subtextHighlight.subtextColor === subtextHighlight.buttonColor &&
          subtextHighlight.subtextColor !== subtextBefore;
        await page.keyboard.press("Escape");
        await sleep(300);
        const ok = idsMatch && needsYou && noInProgress && ticketOpened && subtextHighlighted;
        return {
          ok,
          detail: `ids=${JSON.stringify(ids)} needsYou=${needsYou} noInProgress=${noInProgress} ticketOpened=${ticketOpened} subtext=${JSON.stringify(subtextHighlight)}`,
        };
      },
    );

    // === 17. Chrome-static UI zoom: content scales, the chrome band doesn't ==
    // uiScale now persists to SQLite's app_state (not localStorage) — read it
    // back through the bootstrap payload, per the migration.
    await attempt(
      17,
      "UI zoom command scales content (~1.1x) while the 40px chrome band stays put; uiScale persists to app_state",
      async () => {
        const band = page.locator(".app-region-drag").first();
        const content = cardById(page, "VC-8");
        const bandBefore = await band.boundingBox();
        const contentBefore = await content.boundingBox();
        if (!bandBefore || !contentBefore) throw new Error("band or content card not found");

        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].webContents.send("volli:ui-zoom-command", "in"),
        );
        await sleep(500);
        const bandZoomed = await band.boundingBox();
        const contentZoomed = await content.boundingBox();
        const persistedScale = await page.evaluate(async () => {
          const res = await window.api.data.bootstrap();
          if (!res.ok) return null;
          const raw = res.data.appState["volli:ui"];
          if (!raw) return null;
          try {
            return JSON.parse(raw).state?.uiScale ?? null;
          } catch {
            return null;
          }
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

    // === 18. Global create: plain "c" opens the New-ticket composer; ⌘+Enter creates
    // (The Linear-style composer replaced the primitive dialog in the composer PR:
    // its title placeholder has no ellipsis, and plain Enter moves focus to the
    // body instead of submitting — ⌘/Ctrl+Enter is the create shortcut. The full
    // composer contract lives in composer-basics-smoke.mjs; this check only keeps
    // the board-level "c" → create → card lands wiring honest.)
    await attempt(
      18,
      'Plain "c" hotkey opens the New-ticket composer; typing a title + ⌘Enter creates VC-14 and closes it',
      async () => {
        // Click neutral static text (the "Board" heading) so focus lands
        // somewhere that is definitely not a text-entry target, matching how
        // the hotkey is meant to fire "anywhere in the app".
        await page.getByRole("heading", { name: "Board", exact: true }).click();
        await page.keyboard.press("c");
        await sleep(400);
        const dialogOpenCount = await page.getByRole("dialog").count();
        const title = "Global create dialog smoke card";
        await page.getByPlaceholder("Ticket title").fill(title);
        await page.keyboard.press("Meta+Enter");
        await sleep(400);
        const dialogClosedCount = await page.getByRole("dialog").count();
        const cardVisible = (await page.getByText(title, { exact: true }).count()) >= 1;
        const vc14 = await cardById(page, "VC-14").count();
        const ok = dialogOpenCount === 1 && dialogClosedCount === 0 && cardVisible && vc14 === 1;
        return {
          ok,
          detail: `dialogOpen=${dialogOpenCount} dialogClosedAfter=${dialogClosedCount} cardVisible=${cardVisible} vc14=${vc14}`,
        };
      },
    );

    // === 19. Guard: typing "c" into ⌘K does not open the ticket composer ===
    await attempt(
      19,
      'Guard: "c" typed into the command palette does not open the New-ticket composer',
      async () => {
        await page.keyboard.press("Meta+K");
        const search = page.getByPlaceholder("Search tickets and sessions…");
        await search.waitFor();
        await search.pressSequentially("c");
        await sleep(300);
        const paletteOpen = (await page.getByRole("dialog").count()) === 1;
        const composerClosed = (await page.getByPlaceholder("Ticket title").count()) === 0;
        await page.keyboard.press("Escape");
        await sleep(300);
        const ok = paletteOpen && composerClosed;
        return { ok, detail: `paletteOpen=${paletteOpen} composerClosed=${composerClosed}` };
      },
    );

    // === 20. Header "New ticket" button opens the dialog; Escape closes it ===
    await attempt(20, '"New ticket" header button opens the dialog; Escape closes it', async () => {
      await page.getByRole("button", { name: "New ticket", exact: true }).click();
      await sleep(200);
      const openCount = await page.getByRole("dialog").count();
      await page.keyboard.press("Escape");
      await sleep(300);
      const closedCount = await page.getByRole("dialog").count();
      const ok = openCount === 1 && closedCount === 0;
      return { ok, detail: `open=${openCount} closedAfterEscape=${closedCount}` };
    });

    // === 21. Workspace switcher visibility returns all 60px to the canvas ===
    await attempt(
      21,
      "Workspace switcher toggle returns its full 60px to the canvas and persists across reload",
      async () => {
        const workspaceRail = page.locator("[data-workspace-rail]");
        const mainCanvas = page.locator('[data-slot="sidebar-inset"]');
        const railBefore = await workspaceRail.boundingBox();
        const canvasBefore = await mainCanvas.boundingBox();
        if (!railBefore || !canvasBefore) throw new Error("workspace rail or main canvas missing");

        await page.getByRole("button", { name: "Hide workspace switcher" }).click();
        await sleep(400);
        const railHidden = await workspaceRail.boundingBox();
        const canvasExpanded = await mainCanvas.boundingBox();
        if (!railHidden || !canvasExpanded)
          throw new Error("hidden rail or expanded canvas missing");

        // Reload exercises the real app_state bridge, not just the live Zustand state.
        await page.reload();
        await page.waitForLoadState("domcontentloaded");
        await sleep(1500);
        await goToBoard(page);
        const hiddenPersisted = await page.locator("[data-workspace-rail]").boundingBox();
        const showToggle = page.getByRole("button", { name: "Show workspace switcher" });
        const persisted = hiddenPersisted !== null && hiddenPersisted.width < 1;

        await showToggle.click();
        await sleep(400);
        const railRestored = await page.locator("[data-workspace-rail]").boundingBox();
        const canvasRestored = await page.locator('[data-slot="sidebar-inset"]').boundingBox();
        if (!railRestored || !canvasRestored) throw new Error("restored layout missing");

        const railWasSixty = Math.abs(railBefore.width - 60) < 1;
        const railReachedZero = railHidden.width < 1;
        const canvasGainedSixty = Math.abs(canvasBefore.x - canvasExpanded.x - 60) < 1;
        const restored =
          Math.abs(railRestored.width - railBefore.width) < 1 &&
          Math.abs(canvasRestored.x - canvasBefore.x) < 1;
        const ok = railWasSixty && railReachedZero && canvasGainedSixty && persisted && restored;
        return {
          ok,
          detail: `rail=${railBefore.width}->${railHidden.width}->${railRestored.width} canvasX=${canvasBefore.x}->${canvasExpanded.x}->${canvasRestored.x} persisted=${persisted}`,
        };
      },
    );

    // ===================================================================
    // PHASE D — DURABILITY: the board survives a full Electron relaunch
    // ===================================================================
    // Capture the whole board fingerprint, close the ENTIRE app (not a renderer
    // reload), relaunch a fresh Electron process against the same VOLLI_DB_PATH,
    // and assert the board is byte-for-byte the same — proving it came from
    // SQLite, not localStorage (which is asserted empty of volli:* keys too).
    const preCloseState = await boardStateByColumn(page);
    const preCloseTotal = Object.values(preCloseState).reduce(
      (sum, ids) => sum + (ids?.length ?? 0),
      0,
    );

    await app.close();
    app = await launch(DB_PATH);
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1500);
    await goToBoard(page);

    await attempt(
      22,
      "Durability: full board state survives an Electron close+relaunch from SQLite; no volli:* localStorage",
      async () => {
        const postRelaunchState = await boardStateByColumn(page);
        const postTotal = Object.values(postRelaunchState).reduce(
          (sum, ids) => sum + (ids?.length ?? 0),
          0,
        );
        const volliKeys = await volliLocalStorageKeys(page);
        const stateSurvived =
          JSON.stringify(preCloseState) === JSON.stringify(postRelaunchState) &&
          preCloseTotal >= 14 &&
          postTotal === preCloseTotal;
        const ok = stateSurvived && volliKeys.length === 0;
        return {
          ok,
          detail: `total=${preCloseTotal}->${postTotal} identical=${JSON.stringify(preCloseState) === JSON.stringify(postRelaunchState)} volliKeys=${JSON.stringify(volliKeys)}`,
        };
      },
    );
  } finally {
    await app.close();
  }

  // ===================================================================
  // PHASE E — boot-failure panel on an unwritable VOLLI_DB_PATH
  // ===================================================================
  // Point the DB at a path whose PARENT is a regular file: main's
  // mkdirSync(dirname) throws ENOTDIR, dbHandle is { ok:false }, bootstrap
  // fails, and main.tsx renders the BootErrorPanel instead of the app.
  await attempt(
    23,
    'Boot-failure: an unwritable VOLLI_DB_PATH renders the "Volli couldn\'t load its data" panel',
    async () => {
      const notADir = join(SCRATCH, "not-a-dir");
      await fs.writeFile(notADir, "x"); // a FILE, so join(notADir, "volli.db")'s dirname is unwritable
      const badApp = await launch(join(notADir, "volli.db"));
      try {
        const badPage = await badApp.firstWindow();
        await badPage.waitForLoadState("domcontentloaded");
        await sleep(1500);
        const panel = await badPage
          .getByText("Volli couldn't load its data", { exact: true })
          .count();
        const boardRendered = await badPage
          .getByRole("heading", { name: "Board", exact: true })
          .count();
        const ok = panel === 1 && boardRendered === 0;
        return { ok, detail: `panel=${panel} boardHeading=${boardRendered}` };
      } finally {
        await badApp.close();
      }
    },
  );

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
