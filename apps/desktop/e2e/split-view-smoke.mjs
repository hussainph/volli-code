/**
 * End-to-end acceptance smoke for SPLIT VIEW — panes on a tabbed surface
 * (VC-202, `docs/plans/split-view.md`). Drives the REAL packaged renderer
 * through Playwright against a scratch SQLite database (`VOLLI_DB_PATH`) + an
 * isolated user-data dir, over a REAL git repository and a REAL ticket
 * worktree cut from it.
 *
 * The unit tests own every pure decision: the model (`packages/shared/
 * split-view.test.ts`), what a drop means (`components/split/split-drop.test.ts`)
 * and what the chords mean (`lib/split-shortcut.test.ts`). What only a running
 * app can answer is everything between them —
 *
 *   1. ⌘\ over a ticket workspace opens a SECOND PANE: two `data-pane-id`
 *      cells, the new one focused, each named "Pane N of 2".
 *   2. The new pane is EMPTY and offers the surface menu — and, because the
 *      split came from the keyboard, keyboard focus is already on its first
 *      row (the one place in the grid that moves DOM focus on purpose).
 *   3. Its "New terminal" row boots a PTY and the tab LANDS IN THAT PANE: the
 *      new pane draws its own tab strip holding the session tab, and the
 *      primary strip does not.
 *   4. A tab DRAGGED onto another pane's right edge lights that pane's right
 *      zone and, on release, splits it — the drop-zone half of §4, asserted
 *      through the same `data-zone` hooks the component draws.
 *   5. An empty pane's "Close pane" row collapses it.
 *   6. Closing the last tab of the last extra pane collapses the SURFACE back
 *      to one plane — no pane cells named, no ring, exactly the unsplit
 *      workspace this app had before the feature (the compatibility claim).
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
import { promises as fs } from "node:fs";
import { join } from "node:path";

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

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-split-view-smoke-");
const { attempt, must, summarize } = createRunner();

const PROJECT = { id: "split-view-project", name: "Split View Project", prefix: "SV" };

// ---- DOM probes ------------------------------------------------------------

/** Every pane cell the grid drew, in reading order. */
function readPanes(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-slot="split-view-pane"]')).map((cell) => ({
      paneId: cell.getAttribute("data-pane-id"),
      focused: cell.getAttribute("data-focused") === "true",
      label: cell.getAttribute("aria-label"),
      empty: cell.querySelector('[data-slot="pane-empty-state"]') !== null,
      tabs: Array.from(cell.querySelectorAll('[role="tab"]')).map((tab) =>
        (tab.getAttribute("aria-label") ?? "").trim(),
      ),
    })),
  );
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
    await fs.writeFile(join(projectPath, "readme.md"), "# split view\n");
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
        ok: panes.length === 1 && panes[0]?.label === null && !panes[0]?.focused,
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
            panes[0]?.paneId !== panes[1]?.paneId,
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

    // ---- 4. New terminal lands in THAT pane ---------------------------------
    await must(4, "the menu's New terminal boots a session INTO the new pane", async () => {
      await paneMenuRow(page, "New terminal").click();
      const panes = await waitUntil(
        "the session tab to land in pane 2",
        async () => {
          const seen = await readPanes(page);
          return seen.length === 2 && seen[1]?.tabs.length > 0 ? seen : null;
        },
        { timeout: 20_000 },
      );
      return {
        // The primary pane still draws no strip of its own (the surface's is
        // its), so its cell holds no tabs — the session is the second pane's.
        ok: panes.length === 2 && panes[0].tabs.length === 0 && panes[1].tabs.length === 1,
        detail: JSON.stringify(panes.map((pane) => pane.tabs)),
      };
    });

    // ---- 5. Dragging a tab onto a pane's right edge splits it ---------------
    //
    // The pane COUNT does not grow, and that is the model working rather than
    // the drop failing: the tab was its pane's only one, so that pane empties
    // and collapses as the new one opens. What proves the split happened is
    // that the tab now lives in a pane that did not exist before, opened to the
    // right of the one the zone lit up on.
    await attempt(
      5,
      "a tab dragged to a pane's right edge lights that zone and splits it open",
      async () => {
        const panes = await readPanes(page);
        const sessionTab = panes[1]?.tabs[0];
        if (sessionTab === undefined) return { ok: false, detail: "no session tab to drag" };
        const primary = await paneBox(page, panes[0].paneId);
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
            lit[0]?.paneId === panes[0].paneId &&
            after.length === 2 &&
            after[0]?.paneId === panes[0].paneId &&
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

    // ---- 6. Close pane ------------------------------------------------------
    await attempt(6, "⇧⌘\\ opens an empty pane and its Close pane row collapses it", async () => {
      const before = await paneCount(page);
      await page.keyboard.press("Shift+Meta+\\");
      await waitUntil("one more pane", async () => (await paneCount(page)) === before + 1);
      await paneMenuRow(page, "Close pane").click();
      await waitUntil("the pane to collapse", async () => (await paneCount(page)) === before);
      return { ok: (await paneCount(page)) === before, detail: `panes=${await paneCount(page)}` };
    });

    // ---- 7. The surface collapses back to one plane -------------------------
    await attempt(7, "closing the last split tab returns the workspace to one plane", async () => {
      // Close every session tab a pane holds; the last one leaves no split.
      for (let guard = 0; guard < 4; guard += 1) {
        const panes = await readPanes(page);
        const owner = panes.find((pane) => pane.tabs.length > 0);
        if (owner === undefined) break;
        const label = owner.tabs[0];
        await page
          .locator(
            `[data-slot="split-view-pane"][data-pane-id="${owner.paneId}"] [role="tab"][aria-label="${label}"] [data-testid="tab-close"]`,
          )
          .first()
          .click();
        // A terminal running a foreground process asks first; a shell sitting
        // at its prompt does not, so this is answered only if it appears.
        const confirm = page.getByRole("button", { name: "Close Anyway" });
        if ((await confirm.count()) > 0) await confirm.click();
        await sleep(300);
      }
      await waitUntil("one plane", async () => (await paneCount(page)) === 1, { timeout: 8000 });
      const panes = await readPanes(page);
      return {
        // Unsplit again means UNNAMED again — the compatibility claim, read off
        // the DOM rather than asserted about the store.
        ok: panes.length === 1 && panes[0]?.label === null && panes[0]?.focused === false,
        detail: JSON.stringify(panes.map((pane) => ({ label: pane.label, tabs: pane.tabs }))),
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
