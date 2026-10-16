/**
 * End-to-end acceptance smoke for GROUPED TAB PAIRS (VC-614), retaining the
 * original split-view (VC-202) journey numbering. Drives the REAL packaged renderer
 * through Playwright against a scratch SQLite database (`VOLLI_DB_PATH`) + an
 * isolated user-data dir, over a REAL git repository and a REAL ticket
 * worktree cut from it.
 *
 * The unit tests own every pure decision: the model (`packages/shared/
 * split-view.test.ts`), what a drop means (`components/split/split-drop.test.ts`)
 * and what the chords mean (`lib/split-shortcut.test.ts`). What only a running
 * app can answer is everything between them —
 *
 *   1. An unsplit workspace is one UNNAMED plane with one area strip.
 *   2. ⌘\ opens a temporary empty partner, focused and named "Pane 2 of 2".
 *   3. The partner offers the surface menu, keyboard on its first row.
 *   4. New terminal fills that partner, making ONE chip with TWO members in
 *      the SAME strip. An unrelated file fills the plane; returning to either
 *      member restores the pair, its identities and geometry.
 *   5. A tab dragged onto a pane's right edge lights the right zone and forms
 *      a bounded pair, focused on the dropped tab (the original pointer path).
 *   6. ⇧⌘\ cannot nest a third pane into a complete pair. After unpairing,
 *      it opens an empty partner below; Close pane collapses without closing tabs.
 *   7. A tab-edge drop pairs two tabs; closing one dissolves the chip and
 *      returns to one unnamed plane without closing the survivor.
 *   8. A FILE ROW native HTML5 drag opens a pair with no file tab first,
 *      retaining its DataTransfer type, zone feedback and focused destination.
 *   9. A centre drop dissolves the pair without closing either tab (the old
 *      move-and-collapse path). Left AND right tab-edge drops restore ordered
 *      two-member chips; explicit Unpair tabs also collapses without closing.
 *  10. A centre-of-tab within-strip drag still reorders, not pairs (VC-189).
 *  11. The same keyboard/menu/one-area-strip wiring works on HOME.
 *  12. Clicking a live terminal's overlaid canvas focuses its pair member
 *      after selecting Board, without hiding or recreating that terminal.
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
 * Visible cells only: resident, hidden browser wrappers deliberately have no
 * data-pane-id. Tabs live in ONE area strip, not in cells or pane segments.
 * The active chip's member order names the two cells in reading order; while
 * a keyboard partner is empty, the selected ordinary tab names its owner.
 */
function readPanes(page) {
  return page.evaluate(() => {
    const members = Array.from(
      document.querySelectorAll(
        '[data-slot="grouped-tab-chip"][data-active="true"] [data-slot="grouped-tab-member"] [role="tab"]',
      ),
    );
    const selected = document.querySelector(
      '[data-slot="split-view-tab-bar"] [role="tab"][aria-selected="true"]',
    );
    return Array.from(document.querySelectorAll('[data-slot="split-view-pane"][data-pane-id]'))
      .toSorted((first, second) => {
        const a = first.getBoundingClientRect();
        const b = second.getBoundingClientRect();
        return Math.abs(a.y - b.y) > 2 ? a.y - b.y : a.x - b.x;
      })
      .map((cell, index) => {
        const empty = cell.querySelector('[data-slot="pane-empty-state"]') !== null;
        const tab = empty ? null : (members[index] ?? selected);
        const tabs = tab === null ? [] : [(tab.getAttribute("aria-label") ?? "").trim()];
        return {
          paneId: cell.getAttribute("data-pane-id"),
          focused: cell.getAttribute("data-focused") === "true",
          label: cell.getAttribute("aria-label"),
          empty,
          tabs,
          closable: tab?.querySelector('[data-testid="tab-close"]') ? tabs : [],
        };
      });
  });
}

/** One full-width area strip in either surface, even while a pair is selected. */
async function hasOneAreaStrip(page, label = "Ticket tabs") {
  return page.evaluate((name) => {
    const bars = document.querySelectorAll('[data-slot="split-view-tab-bar"]');
    return (
      bars.length === 1 &&
      bars[0].querySelectorAll('[role="tablist"]').length === 1 &&
      bars[0].querySelector('[role="tablist"]')?.getAttribute("aria-label") === name &&
      document.querySelectorAll('[data-slot="split-view-tab-pane"]').length === 0 &&
      document.querySelectorAll('[data-slot="split-view-pane"] [role="tablist"]').length === 0
    );
  }, label);
}

function readGroups(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-slot="grouped-tab-chip"]')).map((chip) => ({
      id: chip.getAttribute("data-pair-id"),
      active: chip.getAttribute("data-active") === "true",
      tabs: Array.from(chip.querySelectorAll('[data-slot="grouped-tab-member"] [role="tab"]')).map(
        (tab) => tab.getAttribute("aria-label"),
      ),
    })),
  );
}

async function pairAtTabEdge(page, movingLabel, targetLabel, edge) {
  const target = page.getByRole("tab", { name: targetLabel, exact: true }).first();
  const box = await target.boundingBox();
  if (box === null) throw new Error(`no bounding box for pair target ${targetLabel}`);
  await dragTabTo(
    page,
    movingLabel,
    {
      x: box.x + box.width * (edge === "left" ? 0.1 : 0.9),
      y: box.y + box.height / 2,
    },
    { drop: false },
  );
  let highlighted = false;
  try {
    highlighted = await waitUntil(
      "tab edge pairing preview",
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
    "paired tab chip",
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
 * Drag a tab onto a target point with enough intermediate moves for dnd-kit's
 * pointer sensor to activate (4px) and to measure a hover before the release.
 */
async function dragTabTo(page, tabLabel, target, { drop = true } = {}) {
  const from = await page.getByRole("tab", { name: tabLabel, exact: true }).first().boundingBox();
  if (from === null) throw new Error(`no bounding box for tab ${tabLabel}`);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // Three steps: past the activation constraint, into the pane, onto the mark.
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 4 });
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await page.mouse.move(target.x, target.y, { steps: 2 });
  if (drop) await page.mouse.up();
}

/** The ticket area's ONLY strip: ordinary tabs and grouped members together. */
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

    // An unsplit workspace draws ONE pane and names it nothing: "Pane 1 of 1"
    // would be chrome about a choice nobody has made.
    await must(1, "an unsplit workspace is one unnamed plane", async () => {
      const panes = await readPanes(page);
      return {
        ok:
          panes.length === 1 &&
          panes[0]?.label === null &&
          !panes[0]?.focused &&
          (await hasOneAreaStrip(page)),
        detail: JSON.stringify(panes.map((pane) => ({ label: pane.label, focused: pane.focused }))),
      };
    });

    // ---- 2. ⌘\ opens a second pane -----------------------------------------
    await must(
      2,
      "⌘\\ splits the workspace into two named panes, the new one focused",
      async () => {
        await page.keyboard.press("Meta+\\");
        await waitUntil("two panes", async () => (await paneCount(page)) === 2);
        const panes = await readPanes(page);
        return {
          ok:
            panes.length === 2 &&
            panes[0]?.label === "Pane 1 of 2" &&
            panes[1]?.label === "Pane 2 of 2" &&
            panes[1]?.focused === true &&
            panes[0]?.focused === false &&
            panes[0]?.paneId !== panes[1]?.paneId &&
            (await hasOneAreaStrip(page)),
          detail: JSON.stringify(
            panes.map((pane) => ({ label: pane.label, focused: pane.focused })),
          ),
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

    // ---- 4. New terminal fills the pair; unrelated selection is full width --
    await must(
      4,
      "New terminal fills one grouped chip; unrelated tabs hide and restore the pair",
      async () => {
        await paneMenuRow(page, "New terminal").click();
        const panes = await waitUntil(
          "the session tab and grouped chip to fill partner 2",
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
        const groups = await readGroups(page);
        const terminalScreen = page.locator(
          '[data-slot="terminal-viewport-box"]:visible .xterm-screen',
        );
        await terminalScreen.waitFor({ state: "visible", timeout: 20_000 });
        await terminalScreen.evaluate((screen) => {
          window.volliSmokeTicketTerminalScreen = screen;
        });
        const terminalAnchor = await page
          .locator(
            `[data-slot="split-view-pane"][data-pane-id="${panes[1].paneId}"] [data-slot="terminal-pane-anchor"]`,
          )
          .count();
        const labels = groups[0].tabs;
        const originalBoxes = await Promise.all(panes.map((pane) => paneBox(page, pane.paneId)));
        const aside = page.locator("aside");
        await aside.getByTestId("ticket-rail-tab-files").click();
        await waitUntil(
          "the unrelated file row",
          async () => (await aside.locator(SECOND_ROW).count()) === 1,
          { timeout: 10_000 },
        );
        await aside.locator(SECOND_ROW).dblclick();
        const fullWidth = await waitUntil(
          "unrelated file to fill the plane",
          async () => {
            if ((await paneCount(page)) !== 1) return null;
            const only = (await readPanes(page))[0];
            if (only.tabs[0] !== SECOND_FILE) return null;
            const box = await paneBox(page, only.paneId);
            const plane = await page.locator('[data-slot="pair-plane"]').boundingBox();
            return plane !== null &&
              Math.abs(box.width - plane.width) < 2 &&
              only.label === null &&
              (await readGroups(page)).every((group) => !group.active)
              ? box
              : null;
          },
          { timeout: 8000 },
        );
        // Return through BOTH members: selection is a pair, focus is a member.
        let restored = true;
        for (const [index, label] of labels.entries()) {
          await page.getByRole("tab", { name: label, exact: true }).first().click();
          await waitUntil(
            "the original pair and member focus to return",
            async () => {
              const seen = await readPanes(page);
              return (
                seen.length === 2 &&
                seen[index]?.focused &&
                seen.every((pane, i) => pane.paneId === panes[i].paneId)
              );
            },
            { timeout: 6000 },
          );
          const boxes = await Promise.all(panes.map((pane) => paneBox(page, pane.paneId)));
          restored &&= boxes.every(
            (box, i) =>
              Math.abs(box.width - originalBoxes[i].width) < 2 &&
              Math.abs(box.height - originalBoxes[i].height) < 2,
          );
        }
        return {
          ok:
            restored &&
            terminalAnchor === 1 &&
            (await terminalScreen.evaluate(
              (screen) => screen === window.volliSmokeTicketTerminalScreen,
            )) &&
            fullWidth.width > originalBoxes[0].width &&
            labels[0] !== labels[1] &&
            panes[1].focused &&
            (await readGroups(page))[0]?.id === groups[0].id &&
            (await hasOneAreaStrip(page)),
          detail: `groups=${JSON.stringify(groups)} restored=${restored} fullWidth=${fullWidth.width}`,
        };
      },
    );

    // ---- 5. Dragging a tab onto a pane's right edge splits it ---------------
    //
    // Unpair first, leaving both tabs open. A content-edge drop then creates
    // a fresh pair rather than silently reusing the already-identical pair.
    await attempt(
      5,
      "a tab dragged to a pane's right edge lights that zone and splits it open",
      async () => {
        const panes = await readPanes(page);
        const sessionTab = panes[1]?.tabs[0];
        if (sessionTab === undefined) return { ok: false, detail: "no session tab to drag" };
        await page.getByRole("button", { name: "Unpair tabs", exact: true }).click();
        await waitUntil(
          "unpair before the content-edge drop",
          async () => (await paneCount(page)) === 1,
        );
        // Unpair retains the focused member. Select its former partner as
        // the content-edge target before carrying the terminal beside it.
        await page.getByRole("tab", { name: panes[0].tabs[0], exact: true }).first().click();
        const primaryId = (await readPanes(page))[0].paneId;
        const primary = await paneBox(page, primaryId);
        // Deep into the primary pane's right band, vertically centred.
        const target = { x: primary.x + primary.width - 24, y: primary.y + primary.height / 2 };
        await dragTabTo(page, sessionTab, target, { drop: false });
        const lit = await waitUntil(
          "the primary pane's right zone to light up",
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
            const landed = seen.find((pane) => pane.tabs.includes(sessionTab));
            return landed !== undefined && landed.paneId !== panes[1].paneId ? seen : null;
          },
          { timeout: 6000 },
        ).catch(() => readPanes(page));
        return {
          ok:
            lit.length === 1 &&
            lit[0]?.zone === "right" &&
            lit[0]?.paneId === primaryId &&
            after.length === 2 &&
            after[0]?.paneId === primaryId &&
            (await readGroups(page)).length === 1 &&
            (await hasOneAreaStrip(page)) &&
            // The dropped tab is the one you meant to look at: its pane is focused.
            after[1]?.focused === true &&
            after[1]?.paneId !== panes[1].paneId &&
            after[1]?.tabs.includes(sessionTab),
          detail: `lit=${JSON.stringify(lit)} panes=${JSON.stringify(
            after.map((pane) => ({ id: pane.paneId, focused: pane.focused, tabs: pane.tabs })),
          )}`,
        };
      },
    );

    // ---- 6. Max two; a fresh lower partner can still be closed ---------------
    await attempt(
      6,
      "⇧⌘\\ cannot add pane three; an unpaired tab's lower partner can be closed",
      async () => {
        const before = await readPanes(page);
        const pair = await readGroups(page);
        await page.keyboard.press("Shift+Meta+\\");
        // A refused split has no positive UI event; cross a render boundary
        // before reading the unchanged pair rather than sleeping for a guess.
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const atCapacity = await readPanes(page);
        const capped =
          atCapacity.length === 2 &&
          atCapacity.every((pane, i) => pane.paneId === before[i].paneId) &&
          (await readGroups(page))[0]?.id === pair[0]?.id;
        await page.getByRole("button", { name: "Unpair tabs", exact: true }).click();
        await waitUntil(
          "one plane before the fresh lower partner",
          async () => (await paneCount(page)) === 1,
        );
        await page.getByRole("tab", { name: before[1].tabs[0], exact: true }).first().click();
        const strip = await readSurfaceStrip(page);
        await page.keyboard.press("Shift+Meta+\\");
        await waitUntil(
          "focus in the temporary partner",
          async () => (await readFocus(page)).slot === "pane-empty-row",
          { timeout: 4000 },
        );
        const opened = await readPanes(page);
        const boxes = await Promise.all(opened.map((pane) => paneBox(page, pane.paneId)));
        const bounded =
          opened.length === 2 &&
          opened[1]?.empty &&
          opened[1]?.focused &&
          opened[0]?.tabs[0] === before[1]?.tabs[0] &&
          boxes[1].y > boxes[0].y &&
          Math.abs(boxes[0].x - boxes[1].x) < 2;
        let closed = null;
        for (let tries = 0; tries < 3 && closed === null; tries += 1) {
          await paneMenuRow(page, "Close pane").click({ timeout: 8000 });
          closed = await waitUntil(
            "the temporary pair to collapse",
            async () => {
              const seen = await readPanes(page);
              return seen.length === 1 ? seen : null;
            },
            { timeout: 2500 },
          ).catch(() => null);
        }
        return {
          ok:
            capped &&
            bounded &&
            closed !== null &&
            closed[0].label === null &&
            (await readGroups(page)).length === 0 &&
            JSON.stringify(await readSurfaceStrip(page)) === JSON.stringify(strip) &&
            (await hasOneAreaStrip(page)),
          detail: `capped=${capped} opened=${JSON.stringify(opened)} closed=${JSON.stringify(closed)}`,
        };
      },
    );

    // ---- 7. Closing a member dissolves the pair, not the surviving tab ------
    await attempt(
      7,
      "closing a paired tab returns to one unnamed plane and preserves its partner",
      async () => {
        const before = await readPanes(page);
        const terminal = before[0]?.tabs[0];
        const body = (await readSurfaceStrip(page))[0];
        if (!terminal || !body || terminal === body)
          return { ok: false, detail: "no terminal to pair" };
        const preview = await pairAtTabEdge(page, terminal, body, "right");
        const pair = await readGroups(page);
        await page
          .getByRole("tab", { name: terminal, exact: true })
          .first()
          .getByTestId("tab-close")
          .click();
        // A shell at its prompt closes directly; a foreground process may ask.
        await waitUntil(
          "terminal close or confirmation",
          async () =>
            (await page.getByRole("tab", { name: terminal, exact: true }).count()) === 0 ||
            (await page.getByRole("button", { name: "Close Anyway" }).count()) > 0,
          { timeout: 8000 },
        );
        const confirm = page.getByRole("button", { name: "Close Anyway" });
        if ((await confirm.count()) > 0) await confirm.click();
        await waitUntil(
          "terminal gone and pair collapsed",
          async () =>
            (await paneCount(page)) === 1 &&
            (await page.getByRole("tab", { name: terminal, exact: true }).count()) === 0,
          { timeout: 8000 },
        );
        const panes = await readPanes(page);
        return {
          ok:
            preview &&
            pair.length === 1 &&
            pair[0].tabs.length === 2 &&
            panes[0]?.label === null &&
            !panes[0]?.focused &&
            (await readGroups(page)).length === 0 &&
            (await readSurfaceStrip(page)).includes(body) &&
            (await hasOneAreaStrip(page)),
          detail: `paired=${JSON.stringify(pair)} panes=${JSON.stringify(panes)}`,
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
      "a file row dragged from the rail opens a split, with no tab first",
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
        const box = await paneBox(page, panes[0].paneId);
        // Deep into the primary pane's right band.
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
            return seen.length === 2 && seen[1]?.tabs.some((tab) => tab.includes(DRAGGED_FILE))
              ? seen
              : null;
          },
          { timeout: 6000 },
        ).catch(() => readPanes(page));

        return {
          ok:
            started.types?.includes("application/x-volli-file") === true &&
            zone?.zone === "right" &&
            zone?.paneId === panes[0].paneId &&
            after.length === 2 &&
            after[1]?.focused === true &&
            after[1].tabs.some((tab) => tab.includes(DRAGGED_FILE)) &&
            (await readGroups(page)).length === 1 &&
            (await hasOneAreaStrip(page)),
          detail: `types=${JSON.stringify(started.types)} zone=${JSON.stringify(zone)} panes=${JSON.stringify(
            after.map((pane) => pane.tabs),
          )}`,
        };
      },
    );
    // ---- 9. Centre drop unpairs; explicit unpair and both tab edges ----------
    await attempt(
      9,
      "centre drops unpair without closing; explicit unpair and both tab edges work",
      async () => {
        const panes = await readPanes(page);
        const beforeStrip = await readSurfaceStrip(page);
        const tab = panes[1]?.tabs[0];
        const partner = panes[0]?.tabs[0];
        if (!tab || !partner) return { ok: false, detail: "no pair for centre drop" };
        const primary = await paneBox(page, panes[0].paneId);
        await dragTabTo(
          page,
          tab,
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
                (zone) => zone.zone === "center" && zone.paneId === panes[0].paneId,
              ),
            { timeout: 4000 },
          ).catch(() => null);
        } finally {
          await page.mouse.up();
        }
        await waitUntil(
          "centre drop to collapse the pair",
          async () => (await paneCount(page)) === 1 && (await readGroups(page)).length === 0,
          { timeout: 6000 },
        );
        const after = await readPanes(page);
        const strip = await readSurfaceStrip(page);
        const collapsed =
          after[0].label === null &&
          !after[0].focused &&
          JSON.stringify(strip.toSorted()) === JSON.stringify(beforeStrip.toSorted());
        let edges = true;
        for (const edge of ["left", "right"]) {
          const preview = await pairAtTabEdge(page, tab, partner, edge);
          const expected = edge === "left" ? [tab, partner] : [partner, tab];
          const paired = await readGroups(page);
          const cells = await readPanes(page);
          const boxes = await Promise.all(cells.map((pane) => paneBox(page, pane.paneId)));
          edges &&=
            preview &&
            cells.length === 2 &&
            paired.length === 1 &&
            JSON.stringify(paired[0].tabs) === JSON.stringify(expected) &&
            boxes[1].x > boxes[0].x &&
            Math.abs(boxes[1].y - boxes[0].y) < 2 &&
            cells.filter((cell) => cell.focused).length === 1 &&
            (await hasOneAreaStrip(page));
          await page.getByRole("button", { name: "Unpair tabs", exact: true }).click();
          await waitUntil(
            "explicit unpair to collapse",
            async () => (await paneCount(page)) === 1 && (await readGroups(page)).length === 0,
          );
          edges &&=
            JSON.stringify(await readSurfaceStrip(page)) === JSON.stringify(strip) &&
            (await readPanes(page))[0].label === null;
        }
        return {
          ok: centre !== null && collapsed && edges && (await hasOneAreaStrip(page)),
          detail: `centre=${JSON.stringify(centre)} collapsed=${collapsed} edges=${edges} strip=${JSON.stringify(strip)}`,
        };
      },
    );

    // ---- 10. A within-strip reorder still means what it meant ---------------
    await attempt(10, "a drag inside one strip reorders it, exactly as before panes", async () => {
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
      const target = await page
        .getByRole("tab", { name: leading, exact: true })
        .first()
        .boundingBox();
      if (target === null) return { ok: false, detail: "no box for the leading tab" };
      // Drag the trailing tab onto the leading one: the pair swaps.
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
          (await hasOneAreaStrip(page)),
        detail: `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
      };
    });
    // ---- 11. The other surface ---------------------------------------------
    //
    // Home splits through the same grid, the same store twins and the same
    // chord, so this is a WIRING check rather than a second feature: the chord
    // has to resolve Home when Home is what is in front, and Home's plane has
    // to be the thing that splits.
    await attempt(11, "⌘\\ splits HOME too, once Home is the surface in front", async () => {
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
          // The Board rides in the primary pane, which is why it is not empty.
          panes[0]?.empty === false &&
          (await hasOneAreaStrip(page, "Home tabs")),
        detail: JSON.stringify(
          panes.map((pane) => ({ label: pane.label, empty: pane.empty, focused: pane.focused })),
        ),
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
      // Check 11 left Home split with an empty, focused second pane. Wait for
      // the split to SETTLE (the keyboard split's own focus handoff — check
      // 6's discipline), then boot a terminal into it. Retrying the row click
      // retains the existing loaded-machine input-delivery tolerance.
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
      // Board is a MEMBER now: selecting it focuses the first pane, but must
      // leave the second member's live terminal visible in the same pair.
      await page.getByRole("tab", { name: "Board", exact: true }).first().click();
      const primaryTookFocus = await waitUntil(
        "the primary pane to take focus from its tab",
        async () => {
          const seen = await readPanes(page);
          return seen.length === 2 && seen[0]?.focused === true;
        },
        { timeout: 4000 },
      ).catch(() => false);
      if (primaryTookFocus === false) {
        return { ok: false, detail: "primary pane never took focus from its Board tab" };
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
          (await hasOneAreaStrip(page, "Home tabs")),
        detail: JSON.stringify(
          after.map((pane) => ({ id: pane.paneId, focused: pane.focused, tabs: pane.tabs })),
        ),
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
