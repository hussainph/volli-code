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
 *   1. An unsplit workspace is one UNNAMED plane — the state every existing
 *      test and every existing smoke is about.
 *   2. ⌘\ opens a SECOND PANE: two `data-pane-id` cells, the new one focused,
 *      each named "Pane N of 2".
 *   3. That pane is EMPTY and offers the surface menu — and, because the split
 *      came from the keyboard, keyboard focus is already on its first row (the
 *      one place in the grid that moves DOM focus on purpose).
 *   4. Its "New terminal" row boots a PTY and the tab LANDS IN THAT PANE: the
 *      new pane draws its own strip holding the session tab, and the surface's
 *      strip does not.
 *   5. A tab DRAGGED onto another pane's right edge lights that pane's right
 *      zone and, on release, splits it open — the drop-zone half of §4,
 *      asserted through the same `data-zone` hooks the component draws.
 *   6. ⇧⌘\ opens an empty pane and its "Close pane" row collapses it.
 *   7. Closing the last tab of the last extra pane collapses the SURFACE back
 *      to one unnamed plane — the compatibility claim, read off the DOM.
 *   8. A FILE ROW dragged out of the rail's navigator opens a split with no tab
 *      existing first — the native (HTML5) half of §4, a different transport
 *      from the tab drag above that shares only the zones. Driven with real
 *      `DragEvent`s, because Chromium does not synthesize HTML5 drags from
 *      mouse input.
 *   9. The CENTRE zone means "move here": that tab dropped on the primary pane
 *      joins it, and the surface collapses back to one plane.
 *  10. A within-strip reorder still means what it meant before there were panes
 *      (VC-189) — the surface's one drag context did not change the drop.
 *  11. And the same chord splits HOME, which is the other surface — a wiring
 *      check, since both draw the same grid over the same store twins.
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

/**
 * The SURFACE's own strip — the primary pane's, drawn above the grid rather
 * than inside a cell, which is why `readPanes` cannot see it.
 */
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
      const before = (await readPanes(page)).map((pane) => pane.paneId);
      await page.keyboard.press("Shift+Meta+\\");
      // The app's own signal that the split has SETTLED: a keyboard split ends
      // by putting focus on the new pane's first row. Waiting for that (rather
      // than for a pane count, which the store publishes a render earlier)
      // keeps the click below off a pane that is still being drawn.
      await waitUntil(
        "focus to land in the new pane",
        async () => (await readFocus(page)).slot === "pane-empty-row",
        { timeout: 4000 },
      ).catch(() => false);
      const opened = (await readPanes(page)).map((pane) => pane.paneId);
      const minted = opened.filter((id) => !before.includes(id));

      // The click is RETRIED, the way `openTicketViaCard` retries its
      // double-click. On a loaded machine the first trusted click into a pane
      // that appeared a frame ago is sometimes not delivered to the row (the
      // event reaches the document but the row's own listeners never run);
      // clicking again always lands. Worth knowing rather than hiding: see the
      // note in the PHASE 3 report. A programmatic click on the same node works
      // every time, so what the check is really asserting — that the row closes
      // the pane — is not what is flaky.
      let closed = null;
      for (let tries = 0; tries < 3 && closed === null; tries += 1) {
        await paneMenuRow(page, "Close pane").click({ timeout: 8000 });
        closed = await waitUntil(
          "the pane to collapse",
          async () => {
            const now = (await readPanes(page)).map((pane) => pane.paneId);
            return minted.every((id) => !now.includes(id)) ? now : null;
          },
          { timeout: 2500 },
        ).catch(() => null);
      }
      return {
        ok: minted.length === 1 && closed !== null && closed.length === before.length,
        detail: `before=${before.length} minted=${minted.length} after=${closed === null ? "unchanged" : closed.length}`,
      };
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
            after[1].tabs.some((tab) => tab.includes(DRAGGED_FILE)),
          detail: `types=${JSON.stringify(started.types)} zone=${JSON.stringify(zone)} panes=${JSON.stringify(
            after.map((pane) => pane.tabs),
          )}`,
        };
      },
    );
    // ---- 9. The centre zone moves rather than splits ------------------------
    await attempt(
      9,
      "the same tab dropped on the primary pane's CENTRE joins it, and the split collapses",
      async () => {
        const panes = await readPanes(page);
        const tab = panes[1]?.tabs[0];
        if (tab === undefined) return { ok: false, detail: "no tab to move" };
        const primary = await paneBox(page, panes[0].paneId);
        await dragTabTo(page, tab, {
          x: Math.round(primary.x + primary.width / 3),
          y: Math.round(primary.y + primary.height / 2),
        });
        const after = await waitUntil(
          "the surface to collapse to one plane",
          async () => {
            const seen = await readPanes(page);
            return seen.length === 1 ? seen : null;
          },
          { timeout: 6000 },
        ).catch(() => readPanes(page));
        const strip = await readSurfaceStrip(page);
        return {
          // The pane emptied by the move collapses, which takes the whole split
          // with it — and the tab is on the surface's own strip again.
          ok: after.length === 1 && after[0]?.label === null && strip.includes(tab),
          detail: `panes=${after.length} strip=${JSON.stringify(strip)}`,
        };
      },
    );

    // ---- 10. A within-strip reorder still means what it meant ---------------
    await attempt(10, "a drag inside one strip reorders it, exactly as before panes", async () => {
      const aside = page.locator("aside");
      // Pin the file already open (double-click its row), then preview a second
      // one beside it — a preview tab would otherwise be replaced, not joined.
      await aside.locator(FILE_ROW).dblclick();
      await aside.locator(SECOND_ROW).click();
      const before = await waitUntil(
        "two file tabs on the surface's strip",
        async () => {
          const strip = await readSurfaceStrip(page);
          return strip.includes("README.md") && strip.includes("second.md") ? strip : null;
        },
        { timeout: 8000 },
      ).catch(() => null);
      if (before === null) return { ok: false, detail: "never got two file tabs" };

      const target = await page
        .getByRole("tab", { name: before[1], exact: true })
        .first()
        .boundingBox();
      if (target === null) return { ok: false, detail: "no box for the leading tab" };
      // Drag the trailing tab onto the leading one: the pair swaps.
      await dragTabTo(page, before[2], {
        x: Math.round(target.x + target.width / 2),
        y: Math.round(target.y + target.height / 2),
      });
      const after = await waitUntil(
        "the strip to reorder",
        async () => {
          const strip = await readSurfaceStrip(page);
          return strip[1] === before[2] ? strip : null;
        },
        { timeout: 6000 },
      ).catch(() => readSurfaceStrip(page));
      return {
        ok: after[0] === before[0] && after[1] === before[2] && after[2] === before[1],
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
          panes[0]?.empty === false,
        detail: JSON.stringify(
          panes.map((pane) => ({ label: pane.label, empty: pane.empty, focused: pane.focused })),
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
