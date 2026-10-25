/**
 * End-to-end acceptance smoke for TAB GROUPS (VC-614), keeping the split-view
 * (VC-202) journey's numbering where a check still means the same thing.
 * Drives the REAL packaged renderer through Playwright against a scratch
 * SQLite database (`VOLLI_DB_PATH`) + an isolated user-data dir, over a REAL
 * git repository and a REAL ticket worktree cut from it.
 *
 * The unit tests own every pure decision: the model (`packages/shared/
 * split-view.test.ts`), what a drop means (`components/split/split-drop.test.ts`)
 * and what the chords mean (`lib/split-shortcut.test.ts`). What only a running
 * app can answer is everything between them —
 *
 *   1. An ungrouped workspace is one UNNAMED plane under one top strip.
 *   2. ⌘\ makes a GROUP of two: the new pane empty, focused and named "Pane 2
 *      of 2"; the top strip draws ONE chip, and every pane draws its own strip.
 *   3. The empty pane offers the surface menu, keyboard on its first row.
 *   4. New terminal OPENS into that pane; a file opened from the rail stacks in
 *      front of it in the same pane; the terminal comes back unremounted. The
 *      file dragged from its pane strip up to the top strip leaves the group
 *      and shows full width; clicking the chip restores the group exactly.
 *   5. A tab dragged onto a pane's right edge lights that zone and adds a THIRD
 *      pane to the group, focused on the dropped tab.
 *   6. ⇧⌘\ splits the focused pane again (four panes); Close pane on the empty
 *      one hands the layout back without closing a tab.
 *   7. A centre drop moves a tab into that pane's stack; the pane it left
 *      collapses.
 *   8. A FILE ROW native HTML5 drag onto a pane's right edge opens the file in a
 *      new pane of the group, retaining its DataTransfer type and zone feedback.
 *   9. The chip's right-click menu lists the whole group and Ungroups it, every
 *      tab staying open. Left AND right top-strip tab-edge drops group two tabs
 *      in order; closing a tab of a group of two dissolves it, keeping the other.
 *  10. A centre-of-tab drag inside the top strip still reorders (VC-189).
 *  11. ⌘\ groups on HOME too, the Board in the group's first pane.
 *  12. Clicking a live terminal's overlaid canvas focuses its pane after the
 *      Board's pane took focus, without hiding or recreating that terminal.
 *  13. ⌘T while the group is shown opens the new chat INTO the focused pane's
 *      stack, in front — never as a full-width tab beside the group.
 *
 * Every assertion polls (expect-style waits); no bare sleep stands in for a
 * condition (the few fixed sleeps only pace UI settling, never assert).
 *
 *   Run (macOS ONLY — every check drives a ⌘ chord):
 *     vp run --filter @volli/desktop build   # produce dist/ + dist-electron/
 *     node apps/desktop/e2e/split-view-smoke.mjs
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
  closeAppBounded,
  createRunner,
  launch,
  makeGitRepo,
  makeScratch,
  readSeededProjects,
  seedProjects,
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

if (process.platform !== "darwin") {
  console.error(
    `split-view-smoke is macOS-only (got platform "${process.platform}"): every check drives the ` +
      "⌘\\ keybinding, which does not exist on this platform.",
  );
  process.exit(1);
}

const execFileAsync = promisify(execFile);

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-split-view-smoke-");
const { attempt, must, summarize } = createRunner();

const PROJECT = { id: "split-view-project", name: "Split View Project", prefix: "SV" };

/**
 * The rail navigator row this smoke drags. `README.md` is what `makeGitRepo`
 * commits, so it exists in the ticket's WORKTREE too — an untracked file in the
 * main checkout would not, and the navigator lists the worktree.
 */
const DRAGGED_FILE = "README.md";
const FILE_ROW = `[data-testid="ticket-files-row"][data-path="${DRAGGED_FILE}"]`;
/**
 * A second committed file, for the reorder check's second movable tab. At the
 * repository ROOT on purpose: the navigator lists one folder at a time, so a
 * file under `docs/` is not a row until somebody opens `docs/`.
 */
const SECOND_FILE = "second.md";
const SECOND_ROW = `[data-testid="ticket-files-row"][data-path="${SECOND_FILE}"]`;

// ---- DOM probes ------------------------------------------------------------

/**
 * Visible cells only, in reading order. A shown group's cell draws its OWN
 * strip (its stack, front selected); the one full-width cell draws none, and
 * then holds the top strip's selected tab.
 */
function readPanes(page) {
  return page.evaluate(() => {
    const selected = document.querySelector(
      '[data-slot="split-view-tab-bar"] [role="tab"][aria-selected="true"]',
    );
    return Array.from(document.querySelectorAll('[data-slot="split-view-pane"][data-pane-id]'))
      .toSorted((first, second) => {
        const a = first.getBoundingClientRect();
        const b = second.getBoundingClientRect();
        return Math.abs(a.y - b.y) > 2 ? a.y - b.y : a.x - b.x;
      })
      .map((cell) => {
        const empty = cell.querySelector('[data-slot="pane-empty-state"]') !== null;
        const strip = cell.querySelector(':scope > [data-slot="tab-strip"]');
        const tabs =
          strip === null
            ? empty || selected === null
              ? []
              : [(selected.getAttribute("aria-label") ?? "").trim()]
            : Array.from(strip.querySelectorAll('[role="tab"]')).map((tab) =>
                (tab.getAttribute("aria-label") ?? "").trim(),
              );
        const front =
          strip === null
            ? (tabs[0] ?? null)
            : (
                strip
                  .querySelector('[role="tab"][aria-selected="true"]')
                  ?.getAttribute("aria-label") ?? ""
              ).trim() || null;
        return {
          paneId: cell.getAttribute("data-pane-id"),
          focused: cell.getAttribute("data-focused") === "true",
          label: cell.getAttribute("aria-label"),
          empty,
          strip: strip !== null,
          tabs,
          front,
        };
      });
  });
}

/**
 * One top strip across the whole surface, named `label`; and a pane strip in
 * every cell of a shown group (none while one tab is shown full width).
 */
async function hasOneTopStrip(page, label = "Ticket tabs") {
  return page.evaluate((name) => {
    const bars = document.querySelectorAll('[data-slot="split-view-tab-bar"]');
    const cells = document.querySelectorAll('[data-slot="split-view-pane"][data-pane-id]');
    const stripped = Array.from(cells).filter(
      (cell) => cell.querySelector(':scope > [data-slot="tab-strip"]') !== null,
    ).length;
    const empties = Array.from(cells).filter(
      (cell) => cell.querySelector('[data-slot="pane-empty-state"]') !== null,
    ).length;
    return (
      bars.length === 1 &&
      bars[0].querySelectorAll('[role="tablist"]').length === 1 &&
      bars[0].querySelector('[role="tablist"]')?.getAttribute("aria-label") === name &&
      (cells.length === 1 ? stripped === 0 : stripped === cells.length - empties)
    );
  }, label);
}

/** Every group chip on the top strip: its id, whether it is shown, its segments. */
function readGroups(page) {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll('[data-slot="split-view-tab-bar"] [data-slot="grouped-tab-chip"]'),
    ).map((chip) => ({
      id: chip.getAttribute("data-group-id"),
      active: chip.getAttribute("data-active") === "true",
      tabs: Array.from(chip.querySelectorAll('[data-slot="grouped-tab-member"] [role="tab"]')).map(
        (tab) => (tab.getAttribute("aria-label") ?? "").trim(),
      ),
    })),
  );
}

/** A tab on the TOP strip — an ordinary tab, or a group chip's segment. */
function topTab(page, label) {
  return page
    .locator('[data-slot="split-view-tab-bar"]')
    .getByRole("tab", { name: label, exact: true })
    .first();
}

/**
 * The tab a drag picks up: a grouped tab drags from its pane's strip (a chip
 * segment does not drag), an ordinary one from the top strip.
 */
async function draggableTab(page, label) {
  const inPane = page
    .locator('[data-slot="split-view-pane"] > [data-slot="tab-strip"]')
    .getByRole("tab", { name: label, exact: true })
    .first();
  return (await inPane.count()) > 0 ? inPane : topTab(page, label);
}

/** A point on the top strip's bar past its tabs — the bar's own drop target. */
async function topStripPoint(page) {
  const bar = await page.locator('[data-slot="split-view-tab-bar"]').first().boundingBox();
  if (bar === null) throw new Error("no top strip bar");
  return { x: Math.round(bar.x + bar.width * 0.6), y: Math.round(bar.y + bar.height / 2) };
}

/** Right-click a group chip and choose a row of its menu. */
async function chipMenu(page, groupId, item) {
  await page
    .locator(`[data-slot="grouped-tab-chip"][data-group-id="${groupId}"]`)
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

/** The labels a chip's menu lists, pane by pane, with which are checked. */
async function readChipMenu(page, groupId) {
  await page
    .locator(`[data-slot="grouped-tab-chip"][data-group-id="${groupId}"]`)
    .click({ button: "right" });
  const rows = await waitUntil(
    "the chip's menu",
    async () => {
      const seen = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-slot="context-menu-radio-item"]')).map(
          (row) => ({
            label: (row.textContent ?? "").trim(),
            checked: row.getAttribute("aria-checked") === "true",
          }),
        ),
      );
      return seen.length > 0 ? seen : null;
    },
    { timeout: 4000 },
  );
  await page.keyboard.press("Escape");
  return rows;
}

async function groupAtTabEdge(page, movingLabel, targetLabel, edge) {
  const target = topTab(page, targetLabel);
  await dragTabTo(
    page,
    movingLabel,
    async () => {
      await target.scrollIntoViewIfNeeded();
      const box = await target.evaluate((tab) => {
        const rect = tab.closest("[data-pair-target-id]")?.getBoundingClientRect();
        return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
      });
      if (box === null) throw new Error(`no bounds for group target ${targetLabel}`);
      return {
        x: box.x + box.width * (edge === "left" ? 0.12 : 0.88),
        y: box.y + box.height / 2,
      };
    },
    { drop: false },
  );
  let highlighted = false;
  try {
    highlighted = await waitUntil(
      "tab edge grouping preview",
      async () =>
        await target.evaluate(
          (tab, expected) =>
            tab.closest("[data-pair-target-id]")?.getAttribute("data-pair-drop-edge") === expected,
          edge,
        ),
      { timeout: 4000 },
    ).catch(() => false);
  } finally {
    await page.mouse.up();
  }
  await waitUntil(
    `grouped chip (${movingLabel} → ${edge} edge of ${targetLabel}; preview=${highlighted})`,
    async () =>
      (await readGroups(page)).some(
        (group) =>
          group.active && group.tabs.includes(movingLabel) && group.tabs.includes(targetLabel),
      ),
    { timeout: 6000 },
  );
  return highlighted;
}

const paneCount = async (page) => (await readPanes(page)).length;

/** What the keyboard is on right now — slot and accessible name. */
function readFocus(page) {
  return page.evaluate(() => ({
    slot: document.activeElement?.getAttribute("data-slot") ?? null,
    label: document.activeElement?.getAttribute("aria-label") ?? null,
  }));
}

/** A menu row inside the focused (empty) pane. */
function paneMenuRow(page, label) {
  return page.locator(
    `[data-slot="split-view-pane"][data-focused="true"] [data-slot="pane-empty-row"][aria-label="${label}"]`,
  );
}

/** The zone the pointer is currently in, per pane — the drag's own feedback. */
function readActiveZones(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-slot="split-drop-zone"][data-active="true"]')).map(
      (zone) => ({
        zone: zone.getAttribute("data-zone"),
        paneId: zone.closest("[data-slot=split-drop-zones]")?.getAttribute("data-pane-id") ?? null,
      }),
    ),
  );
}

/** A board card, found by the id it prints — the ticket smoke's own locator. */
function cardById(page, displayId) {
  const exact = new RegExp(`^${displayId}$`);
  return page
    .locator("article")
    .filter({ has: page.locator("span.font-mono", { hasText: exact }) });
}

async function openTicketViaCard(page, displayId) {
  for (let tries = 0; tries < 3; tries += 1) {
    await cardById(page, displayId).dblclick();
    try {
      await waitUntil(
        "ticket detail to open",
        async () => (await page.getByRole("tab", { name: displayId, exact: true }).count()) === 1,
        { timeout: 4000 },
      );
      return;
    } catch {
      // fall through and retry
    }
  }
  throw new Error("ticket detail never opened after double-click");
}

/**
 * The part of a tab a hand can actually press: its box clipped to its strip's
 * scrollport. A tab wider than a narrow pane's strip overflows it, and the
 * strip's "Later tabs" control then sits over the far end of the tab's full
 * box — so the full box's centre can be that control, not the tab.
 */
function visibleTabBox(tab) {
  return tab.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const port = element.closest('[data-slot="tab-scroll"]')?.getBoundingClientRect() ?? box;
    const left = Math.max(box.left, port.left);
    const right = Math.min(box.right, port.right);
    return right - left < 8
      ? null
      : { x: left, y: box.top, width: right - left, height: box.height };
  });
}

/**
 * Drag a tab onto a target point with enough intermediate moves for dnd-kit's
 * pointer sensor to activate (4px) and to measure a hover before the release.
 */
async function dragTabTo(page, tabLabel, target, { drop = true } = {}) {
  const source = await draggableTab(page, tabLabel);
  await source.scrollIntoViewIfNeeded();
  const from = await visibleTabBox(source);
  if (from === null) throw new Error(`no visible box for tab ${tabLabel}`);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // Three steps: past the activation constraint, into the pane, onto the mark.
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 4 });
  const destination = typeof target === "function" ? await target() : target;
  await page.mouse.move(destination.x, destination.y, { steps: 12 });
  await page.mouse.move(destination.x, destination.y, { steps: 2 });
  if (drop) await page.mouse.up();
}

/** The ticket's TOP strip: ordinary tabs and each group chip's segments. */
function readSurfaceStrip(page) {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll('[role="tablist"][aria-label="Ticket tabs"] [role="tab"]'),
    ).map((tab) => (tab.getAttribute("aria-label") ?? "").trim()),
  );
}

/** The box of one pane cell, as the pointer sees it. */
async function paneBox(page, paneId) {
  const box = await page
    .locator(`[data-slot="split-view-pane"][data-pane-id="${paneId}"]`)
    .first()
    .boundingBox();
  if (box === null) throw new Error(`no bounding box for pane ${paneId}`);
  return box;
}

async function main() {
  const fakeHome = join(scratch, "home");
  await fs.mkdir(fakeHome, { recursive: true });

  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: { VOLLI_WORKTREE_HOME_DIR: fakeHome },
  });

  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(800);

    const projectPath = await makeGitRepo(scratch, "split-view-");
    // Two more COMMITTED files, so the ticket's worktree has something to open
    // beside its README — an untracked file in the main checkout would not be
    // in the worktree at all.
    await fs.writeFile(join(projectPath, SECOND_FILE), "# second\n");
    await execFileAsync("git", ["add", "-A"], { cwd: projectPath });
    await execFileAsync("git", ["commit", "-q", "-m", "second file"], { cwd: projectPath });
    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    const { byName } = await readSeededProjects(page);
    if (!byName[PROJECT.name]?.id) throw new Error("seeded project missing after import");

    const { displayId } = await createTicketViaBridge(page, PROJECT.name, {
      status: "todo",
      title: "Split view acceptance",
      priority: "medium",
    });
    // Reload so the board store hydrates the new ticket from SQLite.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await waitUntil(
      "seeded card to render",
      async () => (await cardById(page, displayId).count()) === 1,
    );
    await openTicketViaCard(page, displayId);

    // An ungrouped workspace draws ONE pane and names it nothing: "Pane 1 of
    // 1" would be chrome about a choice nobody has made.
    await must(1, "an ungrouped workspace is one unnamed plane", async () => {
      const panes = await readPanes(page);
      return {
        ok:
          panes.length === 1 &&
          panes[0]?.label === null &&
          !panes[0]?.focused &&
          !panes[0]?.strip &&
          (await readGroups(page)).length === 0 &&
          (await hasOneTopStrip(page)),
        detail: JSON.stringify(panes),
      };
    });

    // ---- 2. ⌘\ makes a group of two -----------------------------------------
    await must(
      2,
      "⌘\\ groups the full-width tab with a new, focused, empty pane under one chip",
      async () => {
        await page.keyboard.press("Meta+\\");
        await waitUntil("two panes", async () => (await paneCount(page)) === 2);
        const panes = await readPanes(page);
        const groups = await readGroups(page);
        return {
          ok:
            panes.length === 2 &&
            panes[0]?.label === "Pane 1 of 2" &&
            panes[1]?.label === "Pane 2 of 2" &&
            panes[1]?.focused === true &&
            panes[1]?.empty === true &&
            panes[0]?.focused === false &&
            panes[0]?.strip === true &&
            JSON.stringify(panes[0]?.tabs) === JSON.stringify([displayId]) &&
            panes[0]?.paneId !== "root" &&
            groups.length === 1 &&
            groups[0].active &&
            JSON.stringify(groups[0].tabs) === JSON.stringify([displayId]) &&
            (await hasOneTopStrip(page)),
          detail: JSON.stringify({ panes, groups }),
        };
      },
    );

    // ---- 3. The new pane's menu, and the keyboard already in it -------------
    await must(3, "the new pane offers the surface menu, with focus on its first row", async () => {
      const panes = await readPanes(page);
      const focus = await waitUntil(
        "focus to land on the menu",
        async () => {
          const seen = await readFocus(page);
          return seen.slot === "pane-empty-row" ? seen : null;
        },
        { timeout: 4000 },
      ).catch(() => null);
      return {
        ok: panes[1]?.empty === true && focus?.label === "New chat",
        detail: `empty=${panes[1]?.empty} focus=${JSON.stringify(focus)}`,
      };
    });

    // ---- 4. Open into the focused pane; leave the group; come back ----------
    await must(
      4,
      "New terminal and a file OPEN into the focused pane's stack; a dragged-out tab shows full width and the chip restores the group",
      async () => {
        await paneMenuRow(page, "New terminal").click();
        const panes = await waitUntil(
          "the terminal to open into pane 2",
          async () => {
            const seen = await readPanes(page);
            const groups = await readGroups(page);
            return seen.length === 2 &&
              !seen[1]?.empty &&
              seen[1]?.tabs.length === 1 &&
              groups.length === 1 &&
              groups[0].active &&
              groups[0].tabs.length === 2
              ? seen
              : null;
          },
          { timeout: 20_000 },
        );
        const terminal = panes[1].tabs[0];
        const groupId = (await readGroups(page))[0].id;
        const terminalScreen = page.locator(
          '[data-slot="terminal-viewport-box"]:visible .xterm-screen',
        );
        await terminalScreen.waitFor({ state: "visible", timeout: 20_000 });
        await terminalScreen.evaluate((screen) => {
          window.volliSmokeTicketTerminalScreen = screen;
        });
        const originalBoxes = await Promise.all(panes.map((pane) => paneBox(page, pane.paneId)));

        // A file OPENED from the rail while the group is shown joins the
        // focused pane — pane 2 — in front of the terminal.
        const aside = page.locator("aside");
        await aside.getByTestId("ticket-rail-tab-files").click();
        await waitUntil(
          "the second file row",
          async () => (await aside.locator(SECOND_ROW).count()) === 1,
          { timeout: 10_000 },
        );
        await aside.locator(SECOND_ROW).dblclick();
        const stacked = await waitUntil(
          "the file to stack in front of the terminal",
          async () => {
            const seen = await readPanes(page);
            return seen.length === 2 &&
              JSON.stringify(seen[1]?.tabs) === JSON.stringify([terminal, SECOND_FILE]) &&
              seen[1]?.front === SECOND_FILE
              ? seen
              : null;
          },
          { timeout: 8000 },
        ).catch(() => null);
        // Back to the terminal through its pane's own strip: the same screen.
        await (await draggableTab(page, terminal)).click();
        await waitUntil(
          "the terminal in front again",
          async () => (await readPanes(page))[1]?.front === terminal,
          { timeout: 4000 },
        );
        const sameTerminal = await terminalScreen.evaluate(
          (screen) => screen === window.volliSmokeTicketTerminalScreen,
        );

        // The file dragged from its pane strip up onto the top strip leaves
        // the group — an ordinary tab again, shown full width.
        await dragTabTo(page, SECOND_FILE, () => topStripPoint(page));
        const fullWidth = await waitUntil(
          "the file to leave the group and fill the plane",
          async () => {
            const seen = await readPanes(page);
            const groups = await readGroups(page);
            return seen.length === 1 &&
              seen[0].tabs[0] === SECOND_FILE &&
              seen[0].label === null &&
              groups.length === 1 &&
              !groups[0].active &&
              !groups[0].tabs.includes(SECOND_FILE)
              ? seen
              : null;
          },
          { timeout: 8000 },
        ).catch(() => null);
        const fullBox = fullWidth === null ? null : await paneBox(page, fullWidth[0].paneId);

        // The chip's terminal segment brings the group back exactly.
        await topTab(page, terminal).click();
        await waitUntil(
          "the group, its panes and its focus to return",
          async () => {
            const seen = await readPanes(page);
            return (
              seen.length === 2 &&
              seen[1]?.focused &&
              seen.every((pane, i) => pane.paneId === panes[i].paneId)
            );
          },
          { timeout: 6000 },
        );
        const boxes = await Promise.all(panes.map((pane) => paneBox(page, pane.paneId)));
        const restored = boxes.every(
          (box, i) =>
            Math.abs(box.width - originalBoxes[i].width) < 2 &&
            Math.abs(box.height - originalBoxes[i].height) < 2,
        );
        return {
          ok:
            stacked !== null &&
            sameTerminal &&
            fullWidth !== null &&
            fullBox !== null &&
            fullBox.width > originalBoxes[0].width &&
            restored &&
            (await terminalScreen.evaluate(
              (screen) => screen === window.volliSmokeTicketTerminalScreen,
            )) &&
            (await readGroups(page))[0]?.id === groupId &&
            (await hasOneTopStrip(page)),
          detail: `stacked=${JSON.stringify(stacked)} fullWidth=${JSON.stringify(fullWidth)} restored=${restored} same=${sameTerminal}`,
        };
      },
    );

    // ---- 5. A content-edge drop adds a third pane ---------------------------
    await attempt(
      5,
      "a tab dragged to a pane's right edge lights that zone and adds a third pane",
      async () => {
        const before = await readPanes(page);
        const groupId = (await readGroups(page))[0]?.id;
        const primaryId = before[0].paneId;
        const primary = await paneBox(page, primaryId);
        // Deep into the Body pane's right band, vertically centred.
        const target = { x: primary.x + primary.width - 24, y: primary.y + primary.height / 2 };
        await dragTabTo(page, SECOND_FILE, target, { drop: false });
        const lit = await waitUntil(
          "the Body pane's right zone to light up",
          async () => {
            const zones = await readActiveZones(page);
            return zones.length > 0 ? zones : null;
          },
          { timeout: 4000 },
        ).catch(() => []);
        await page.mouse.up();
        const after = await waitUntil(
          "the tab to land in a pane the drop opened",
          async () => {
            const seen = await readPanes(page);
            return seen.length === 3 ? seen : null;
          },
          { timeout: 6000 },
        ).catch(() => readPanes(page));
        const groups = await readGroups(page);
        return {
          ok:
            lit.length === 1 &&
            lit[0]?.zone === "right" &&
            lit[0]?.paneId === primaryId &&
            after.length === 3 &&
            after[0]?.paneId === primaryId &&
            after[1]?.focused === true &&
            JSON.stringify(after[1]?.tabs) === JSON.stringify([SECOND_FILE]) &&
            after[2]?.paneId === before[1].paneId &&
            after[2]?.label === "Pane 3 of 3" &&
            groups.length === 1 &&
            groups[0].id === groupId &&
            groups[0].tabs.length === 3 &&
            (await hasOneTopStrip(page)),
          detail: `lit=${JSON.stringify(lit)} panes=${JSON.stringify(after)} groups=${JSON.stringify(groups)}`,
        };
      },
    );

    // ---- 6. A fourth pane, and Close pane on it -------------------------------
    await attempt(
      6,
      "⇧⌘\\ splits the focused pane again; Close pane on the empty one closes no tab",
      async () => {
        const before = await readPanes(page);
        const strip = await readSurfaceStrip(page);
        await page.keyboard.press("Shift+Meta+\\");
        await waitUntil(
          "focus in the new empty pane",
          async () => (await readFocus(page)).slot === "pane-empty-row",
          { timeout: 4000 },
        );
        const opened = await readPanes(page);
        const lower = opened.find((pane) => pane.empty);
        const above = opened.find((pane) => pane.paneId === before[1].paneId);
        const boxes =
          lower === undefined || above === undefined
            ? null
            : [await paneBox(page, above.paneId), await paneBox(page, lower.paneId)];
        const grew =
          opened.length === 4 &&
          lower?.focused === true &&
          boxes !== null &&
          boxes[1].y > boxes[0].y &&
          Math.abs(boxes[0].x - boxes[1].x) < 2;
        let closed = null;
        for (let tries = 0; tries < 3 && closed === null; tries += 1) {
          await paneMenuRow(page, "Close pane").click({ timeout: 8000 });
          closed = await waitUntil(
            "the empty pane to close",
            async () => {
              const seen = await readPanes(page);
              return seen.length === 3 ? seen : null;
            },
            { timeout: 2500 },
          ).catch(() => null);
        }
        return {
          ok:
            grew &&
            closed !== null &&
            closed.every((pane, i) => pane.paneId === before[i].paneId) &&
            JSON.stringify(await readSurfaceStrip(page)) === JSON.stringify(strip) &&
            (await hasOneTopStrip(page)),
          detail: `opened=${JSON.stringify(opened)} closed=${JSON.stringify(closed)}`,
        };
      },
    );

    // ---- 7. A centre drop moves a tab into that pane's stack -----------------
    await attempt(
      7,
      "a centre drop stacks the tab in that pane, and the pane it left collapses",
      async () => {
        const before = await readPanes(page);
        const primary = await paneBox(page, before[0].paneId);
        await dragTabTo(
          page,
          SECOND_FILE,
          {
            x: Math.round(primary.x + primary.width / 2),
            y: Math.round(primary.y + primary.height / 2),
          },
          { drop: false },
        );
        let centre = null;
        try {
          centre = await waitUntil(
            "centre zone feedback",
            async () =>
              (await readActiveZones(page)).find(
                (zone) => zone.zone === "center" && zone.paneId === before[0].paneId,
              ),
            { timeout: 4000 },
          ).catch(() => null);
        } finally {
          await page.mouse.up();
        }
        const after = await waitUntil(
          "the file to join the Body's stack",
          async () => {
            const seen = await readPanes(page);
            return seen.length === 2 &&
              JSON.stringify(seen[0]?.tabs) === JSON.stringify([displayId, SECOND_FILE])
              ? seen
              : null;
          },
          { timeout: 6000 },
        ).catch(() => readPanes(page));
        return {
          ok:
            centre != null &&
            after.length === 2 &&
            after[0]?.front === SECOND_FILE &&
            after[0]?.focused === true &&
            after[1]?.paneId === before[2]?.paneId &&
            (await readSurfaceStrip(page)).length === 2 &&
            (await hasOneTopStrip(page)),
          detail: `centre=${JSON.stringify(centre)} panes=${JSON.stringify(after)}`,
        };
      },
    );

    // ---- 8. A rail row drags onto the plane ---------------------------------
    //
    // The native transport, which Playwright's mouse cannot drive: Chromium
    // starts an HTML5 drag from the OS, not from synthesized mouse events. So
    // the events are dispatched by hand, on the real row and the real overlay,
    // through one real `DataTransfer` — the row's own handler is what fills it,
    // and the drop reads it back exactly as a hand-dragged one would.
    await attempt(
      8,
      "a file row dragged from the rail onto a pane's right edge opens it in a new pane",
      async () => {
        const aside = page.locator("aside");
        await aside.getByTestId("ticket-rail-tab-files").click();
        await waitUntil(
          "the files list",
          async () => (await aside.getByTestId("ticket-files-list").count()) === 1,
          { timeout: 10_000 },
        );
        await waitUntil("the file row", async () => (await aside.locator(FILE_ROW).count()) === 1, {
          timeout: 10_000,
        });

        const panes = await readPanes(page);
        const box = await paneBox(page, panes[1].paneId);
        // Deep into the terminal pane's right band.
        const point = {
          x: Math.round(box.x + box.width - 24),
          y: Math.round(box.y + box.height / 2),
        };

        // The row's own `dragstart` fills the transfer and announces the drag;
        // the transfer is parked on `window` so every event below is the SAME
        // one, exactly as a real gesture would carry it.
        const started = await page.evaluate((selector) => {
          const row = document.querySelector(selector);
          if (row === null) return { error: "no row" };
          if (row.getAttribute("draggable") !== "true") return { error: "row is not draggable" };
          const transfer = new DataTransfer();
          window.volliDragTransfer = transfer;
          row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
          return { types: [...transfer.types] };
        }, FILE_ROW);
        if (started.error !== undefined) return { ok: false, detail: started.error };

        // The zones are a render away from the announcement, not a tick.
        await waitUntil(
          "the panes to offer their zones",
          async () => (await page.locator('[data-slot="split-drop-zones"]').count()) > 0,
          { timeout: 4000 },
        );

        const dispatchAt = (kind) =>
          page.evaluate(
            ({ at, type }) => {
              const transfer = window.volliDragTransfer;
              const overlay = document
                .elementFromPoint(at.x, at.y)
                ?.closest?.('[data-slot="split-drop-zones"]');
              if (!overlay) return false;
              overlay.dispatchEvent(
                new DragEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  dataTransfer: transfer,
                  clientX: at.x,
                  clientY: at.y,
                }),
              );
              return true;
            },
            { at: point, type: kind },
          );

        if (!(await dispatchAt("dragover"))) {
          return { ok: false, detail: "no zone overlay under the pointer" };
        }

        // Read the highlight from a real intermediate state — a React render
        // later, which is why this is a poll and not the same tick.
        const zone = await waitUntil(
          "the right zone to light up for the native drag",
          async () => {
            const zones = await readActiveZones(page);
            return zones.length > 0 ? zones[0] : null;
          },
          { timeout: 4000 },
        ).catch(() => null);

        await dispatchAt("drop");
        await page.evaluate((selector) => {
          document.querySelector(selector)?.dispatchEvent(
            new DragEvent("dragend", {
              bubbles: true,
              dataTransfer: window.volliDragTransfer,
            }),
          );
        }, FILE_ROW);

        const after = await waitUntil(
          "the file to open in a pane of its own",
          async () => {
            const seen = await readPanes(page);
            return seen.length === 3 && seen[2]?.tabs.some((tab) => tab.includes(DRAGGED_FILE))
              ? seen
              : null;
          },
          { timeout: 6000 },
        ).catch(() => readPanes(page));

        return {
          ok:
            started.types?.includes("application/x-volli-file") === true &&
            zone?.zone === "right" &&
            zone?.paneId === panes[1].paneId &&
            after.length === 3 &&
            after[2]?.focused === true &&
            after[2].tabs.some((tab) => tab.includes(DRAGGED_FILE)) &&
            // Opened from a pane, the file never ALSO stays in the pane that
            // had focus when it opened.
            !after[0].tabs.some((tab) => tab.includes(DRAGGED_FILE)) &&
            (await readGroups(page)).length === 1 &&
            (await hasOneTopStrip(page)),
          detail: `types=${JSON.stringify(started.types)} zone=${JSON.stringify(zone)} panes=${JSON.stringify(
            after.map((pane) => pane.tabs),
          )}`,
        };
      },
    );

    // ---- 9. The chip's menu, Ungroup, and both top-strip tab edges -----------
    await attempt(
      9,
      "the chip menu lists and ungroups the group; left and right tab edges group in order; closing a tab of two dissolves",
      async () => {
        const groupId = (await readGroups(page))[0]?.id;
        const panes = await readPanes(page);
        const terminal = panes[1]?.tabs[0];
        if (!groupId || !terminal) return { ok: false, detail: "no group to ungroup" };
        const menu = await readChipMenu(page, groupId);
        const listed =
          JSON.stringify(menu.map((row) => row.label)) ===
            JSON.stringify(panes.flatMap((pane) => pane.tabs)) &&
          menu.filter((row) => row.checked).length === panes.length;
        await chipMenu(page, groupId, "Ungroup");
        const ungrouped = await waitUntil(
          "Ungroup to leave one plane and every tab open",
          async () => {
            const strip = await readSurfaceStrip(page);
            return (await paneCount(page)) === 1 &&
              (await readGroups(page)).length === 0 &&
              [displayId, terminal, SECOND_FILE].every((tab) => strip.includes(tab)) &&
              strip.some((tab) => tab.includes(DRAGGED_FILE))
              ? strip
              : null;
          },
          { timeout: 6000 },
        ).catch(() => null);

        let edges = true;
        const previews = [];
        for (const edge of ["left", "right"]) {
          const preview = await groupAtTabEdge(page, terminal, displayId, edge);
          previews.push(preview);
          const expected = edge === "left" ? [terminal, displayId] : [displayId, terminal];
          const grouped = await readGroups(page);
          const cells = await readPanes(page);
          const boxes = await Promise.all(cells.map((pane) => paneBox(page, pane.paneId)));
          edges &&=
            preview &&
            cells.length === 2 &&
            grouped.length === 1 &&
            JSON.stringify(grouped[0].tabs) === JSON.stringify(expected) &&
            boxes[1].x > boxes[0].x &&
            Math.abs(boxes[1].y - boxes[0].y) < 2 &&
            cells.filter((cell) => cell.focused).length === 1 &&
            cells.find((cell) => cell.focused)?.tabs[0] === terminal &&
            (await hasOneTopStrip(page));
          if (edge === "left") {
            await chipMenu(page, grouped[0].id, "Ungroup");
            await waitUntil(
              "Ungroup to collapse",
              async () => (await paneCount(page)) === 1 && (await readGroups(page)).length === 0,
            );
          }
        }

        // Closing one tab of a group of two dissolves it and keeps the other.
        await (await draggableTab(page, terminal)).getByTestId("tab-close").click();
        await waitUntil(
          "terminal close or confirmation",
          async () =>
            (await page.getByRole("tab", { name: terminal, exact: true }).count()) === 0 ||
            (await page.getByRole("button", { name: "Close Anyway" }).count()) > 0,
          { timeout: 8000 },
        );
        const confirm = page.getByRole("button", { name: "Close Anyway" });
        if ((await confirm.count()) > 0) await confirm.click();
        const dissolved = await waitUntil(
          "terminal gone and group dissolved",
          async () =>
            (await paneCount(page)) === 1 &&
            (await readGroups(page)).length === 0 &&
            (await page.getByRole("tab", { name: terminal, exact: true }).count()) === 0 &&
            (await readSurfaceStrip(page)).includes(displayId),
          { timeout: 8000 },
        ).catch(() => false);
        return {
          ok: listed && ungrouped !== null && edges && dissolved && (await hasOneTopStrip(page)),
          detail: `menu=${JSON.stringify(menu)} ungrouped=${JSON.stringify(ungrouped)} previews=${JSON.stringify(previews)} edges=${edges} dissolved=${dissolved}`,
        };
      },
    );

    // ---- 10. A within-strip reorder still means what it meant ---------------
    await attempt(10, "a drag inside the top strip reorders it, exactly as before", async () => {
      const aside = page.locator("aside");
      // Pin both files so neither can replace the other as a preview.
      await aside.locator(FILE_ROW).dblclick();
      await aside.locator(SECOND_ROW).dblclick();
      const before = await waitUntil(
        "two file tabs on the surface's strip",
        async () => {
          const strip = await readSurfaceStrip(page);
          return strip.includes("README.md") && strip.includes("second.md") ? strip : null;
        },
        { timeout: 8000 },
      ).catch(() => null);
      if (before === null) return { ok: false, detail: "never got two file tabs" };

      const leading =
        before.indexOf(DRAGGED_FILE) < before.indexOf(SECOND_FILE) ? DRAGGED_FILE : SECOND_FILE;
      const trailing = leading === DRAGGED_FILE ? SECOND_FILE : DRAGGED_FILE;
      const expected = [...before];
      [expected[before.indexOf(leading)], expected[before.indexOf(trailing)]] = [trailing, leading];
      const target = await topTab(page, leading).boundingBox();
      if (target === null) return { ok: false, detail: "no box for the leading tab" };
      // Drag the trailing tab onto the leading one: the two swap.
      await dragTabTo(page, trailing, {
        x: Math.round(target.x + target.width / 2),
        y: Math.round(target.y + target.height / 2),
      });
      const after = await waitUntil(
        "the strip to reorder",
        async () => {
          const strip = await readSurfaceStrip(page);
          return JSON.stringify(strip) === JSON.stringify(expected) ? strip : null;
        },
        { timeout: 6000 },
      ).catch(() => readSurfaceStrip(page));
      return {
        ok:
          JSON.stringify(after) === JSON.stringify(expected) &&
          (await readGroups(page)).length === 0 &&
          (await hasOneTopStrip(page)),
        detail: `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
      };
    });
    // ---- 11. The other surface ---------------------------------------------
    //
    // Home groups through the same grid, the same store twins and the same
    // chord, so this is a WIRING check rather than a second feature: the chord
    // has to resolve Home when Home is what is in front.
    await attempt(11, "⌘\\ groups on HOME too, once Home is the surface in front", async () => {
      await page.keyboard.press("Escape");
      await waitUntil("the board", async () => (await cardById(page, displayId).count()) === 1, {
        timeout: 6000,
      });
      await page.keyboard.press("Meta+\\");
      const panes = await waitUntil(
        "two panes on Home",
        async () => {
          const seen = await readPanes(page);
          return seen.length === 2 ? seen : null;
        },
        { timeout: 6000 },
      ).catch(() => readPanes(page));
      return {
        ok:
          panes.length === 2 &&
          panes[1]?.focused === true &&
          panes[1]?.empty === true &&
          // The Board rides in the group's first pane, under its own strip.
          panes[0]?.empty === false &&
          JSON.stringify(panes[0]?.tabs) === JSON.stringify(["Board"]) &&
          (await readGroups(page)).length === 1 &&
          (await hasOneTopStrip(page, "Home tabs")),
        detail: JSON.stringify(panes),
      };
    });

    // ---- 12. A click INTO a live terminal focuses its pane ------------------
    //
    // The terminal is not a child of its pane's cell — it is a viewport box
    // positioned OVER the pane's anchor (the keep-alive seam), so the cell's
    // own pointer-down capture never sees this click; the box raises pane
    // focus itself (validation finding V1). Without that wiring the ring, the
    // rail and every surface chord keep reading the OTHER pane while you type
    // in this one — for exactly the tab kind this product centres on.
    await attempt(12, "clicking a live terminal's canvas focuses the pane under it", async () => {
      // Check 11 left Home grouped with an empty, focused second pane. Wait for
      // the split to SETTLE (the keyboard split's own focus handoff), then boot
      // a terminal into it. Retrying the row click retains the existing
      // loaded-machine input-delivery tolerance.
      await waitUntil(
        "focus to land in Home's new pane",
        async () => (await readFocus(page)).slot === "pane-empty-row",
        { timeout: 4000 },
      ).catch(() => false);
      let withTerminal = await readPanes(page);
      for (let tries = 0; tries < 3 && (withTerminal[1]?.tabs.length ?? 0) === 0; tries += 1) {
        await paneMenuRow(page, "New terminal").click({ timeout: 8000 });
        withTerminal = await waitUntil(
          "the terminal tab to land in Home's second pane",
          async () => {
            const seen = await readPanes(page);
            return seen.length === 2 && (seen[1]?.tabs.length ?? 0) > 0 ? seen : null;
          },
          { timeout: 6000 },
        ).catch(() => readPanes(page));
      }
      const paneId = withTerminal[1]?.paneId;
      if (withTerminal.length !== 2 || (withTerminal[1]?.tabs.length ?? 0) === 0 || !paneId) {
        return { ok: false, detail: `no terminal landed: ${JSON.stringify(withTerminal)}` };
      }
      const groups = await readGroups(page);
      const screen = page.locator('[data-slot="terminal-viewport-box"]:visible .xterm-screen');
      await screen.waitFor({ state: "visible", timeout: 20_000 });
      await screen.evaluate((node) => {
        window.volliSmokeHomeTerminalScreen = node;
      });
      // The Board is a group tab: selecting it focuses the first pane, and
      // must leave the second pane's live terminal visible in the same group.
      await topTab(page, "Board").click();
      const primaryTookFocus = await waitUntil(
        "the Board's pane to take focus from its tab",
        async () => {
          const seen = await readPanes(page);
          return seen.length === 2 && seen[0]?.focused === true;
        },
        { timeout: 4000 },
      ).catch(() => false);
      if (primaryTookFocus === false) {
        return { ok: false, detail: "the Board's pane never took focus from its tab" };
      }
      // Now click INSIDE the second pane's content — the terminal's canvas,
      // which is the viewport box overlaid on that pane's anchor.
      const box = await paneBox(page, paneId);
      const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
      const terminalUnderPointer = await waitUntil(
        "live terminal under the pointer",
        async () =>
          page.evaluate(
            ({ x, y }) =>
              document.elementFromPoint(x, y)?.closest('[data-slot="terminal-viewport-box"]') !=
                null && document.elementFromPoint(x, y)?.closest(".xterm") != null,
            point,
          ),
        { timeout: 6000 },
      );
      await page.mouse.click(point.x, point.y);
      const after = await waitUntil(
        "focus to move to the terminal's pane",
        async () => {
          const seen = await readPanes(page);
          return seen.find((pane) => pane.paneId === paneId)?.focused === true ? seen : null;
        },
        { timeout: 4000 },
      ).catch(() => readPanes(page));
      return {
        ok:
          terminalUnderPointer &&
          after.length === 2 &&
          after.find((pane) => pane.paneId === paneId)?.focused === true &&
          groups.length === 1 &&
          groups[0].tabs.length === 2 &&
          (await readGroups(page))[0]?.id === groups[0].id &&
          (await screen.evaluate((node) => node === window.volliSmokeHomeTerminalScreen)) &&
          (await hasOneTopStrip(page, "Home tabs")),
        detail: JSON.stringify(after),
      };
    });

    // ---- 13. A new chat OPENS into the focused pane --------------------------
    //
    // The owner's report this whole change answers: with a group on screen a
    // new chat used to become a full-width tab of its own, hiding the group.
    await attempt(13, "⌘T opens the new chat into the focused pane's stack", async () => {
      const before = await readPanes(page);
      const groupId = (await readGroups(page))[0]?.id;
      const terminal = before[1]?.tabs[0];
      if (before.length !== 2 || !groupId || !terminal) {
        return { ok: false, detail: `no Home group to open into: ${JSON.stringify(before)}` };
      }
      // Keyboard on the terminal's own strip tab: the second pane is focused,
      // and the chord is not swallowed by a canvas.
      await (await draggableTab(page, terminal)).click();
      await page.keyboard.press("Meta+t");
      const after = await waitUntil(
        "the chat to stack in front of the terminal",
        async () => {
          const seen = await readPanes(page);
          return seen.length === 2 &&
            seen[1]?.tabs.length === 2 &&
            seen[1]?.tabs[0] === terminal &&
            seen[1]?.front === "Chat"
            ? seen
            : null;
        },
        { timeout: 8000 },
      ).catch(() => readPanes(page));
      const groups = await readGroups(page);
      return {
        ok:
          after.length === 2 &&
          after[1]?.focused === true &&
          after[1]?.front === "Chat" &&
          groups.length === 1 &&
          groups[0].id === groupId &&
          groups[0].active &&
          JSON.stringify(groups[0].tabs) === JSON.stringify(["Board", "Chat"]) &&
          (await hasOneTopStrip(page, "Home tabs")),
        detail: `panes=${JSON.stringify(after)} groups=${JSON.stringify(groups)}`,
      };
    });
  } finally {
    await closeAppBounded(app).catch(() => {});
    await cleanup();
  }
}

let code = 1;
try {
  await main();
  code = summarize();
} catch (error) {
  console.error(error);
  code = 1;
}
process.exit(code);
