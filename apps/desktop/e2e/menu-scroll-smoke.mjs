/**
 * End-to-end regression smoke for VC-138: wheel scrolling inside searchable
 * dropdowns / floating menus.
 *
 * The bug: a non-modal Popover portals its content to `document.body`, and the
 * modal New-ticket composer's scroll lock (react-remove-scroll) cancels every
 * wheel event whose target is outside the dialog's own content — so the label
 * picker (and the model/branch pickers, the same shape) could not be scrolled
 * by wheel or trackpad while the composer was open. Search worked, the
 * scrollbar worked, the gesture did not. The fix lives in `ui/popover.tsx`
 * (the popover claims its wheel gestures; see the comment there).
 *
 * Drives the BUILT app through Playwright against a scratch SQLite database:
 *
 *   1. Label picker inside the modal New-ticket composer — the original repro.
 *      Seeds 40 labels, opens the composer's Labels chip, wheels over the cmdk
 *      list, asserts the list actually scrolled.
 *   2. Wheel-up over the same list scrolls back up (a claim that only worked
 *      one direction would pass check 1 and still be broken).
 *   3. The ticket detail rail's label picker (NO dialog underneath) still
 *      scrolls — the claim must not have regressed the unlocked case.
 *   4. The board card context menu's Labels submenu still scrolls — the menu
 *      family keeps its own lock and must stay untouched by the fix.
 *
 * This is a MANUALLY-RUN smoke (needs a display + the built app); it is NOT
 * wired into `vp test`.
 *
 *   Run:
 *     pnpm run build                        # produce dist/ + dist-electron/
 *     node apps/desktop/e2e/menu-scroll-smoke.mjs
 *
 * Requires: playwright-core (devDependency of @volli/desktop).
 * Exit code is non-zero if any numbered check fails.
 */
import {
  createRunner,
  launch,
  makeScratch,
  makeGitRepo,
  assertProfileIsolated,
  seedProjects,
  sleep,
} from "./lib/smoke-kit.mjs";

/** Enough labels that the picker's `max-h-64` list overflows at any window size. */
const LABEL_COUNT = 40;

/**
 * Land on Home's Board tab (both nav and tab are remembered per-workspace and
 * both default to it, but re-assert after every reload to be robust).
 */
async function goToBoard(page) {
  const homeNav = page.getByRole("button", { name: "Home", exact: true });
  if (await homeNav.count()) await homeNav.first().click();
  const boardTab = page
    .getByRole("tablist", { name: "Home tabs", exact: true })
    .getByRole("tab", { name: "Board" });
  if (await boardTab.count()) await boardTab.first().click();
  await sleep(500);
}

/** The picker list's geometry + scroll offset, read straight from the DOM. */
function readList(page) {
  return page.evaluate(() => {
    const list = document.querySelector('[data-slot="command-list"]');
    if (!list) return null;
    const r = list.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      scrollTop: list.scrollTop,
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
    };
  });
}

/** Dispatch one wheel notch over the middle of the picker list. */
async function wheelOverList(page, geometry, deltaY) {
  await page.mouse.move(
    geometry.x + geometry.width / 2,
    geometry.y + Math.min(geometry.height / 2, 100),
  );
  await page.mouse.wheel(0, deltaY);
  await sleep(300);
}

async function main() {
  const { scratch, userDataDir, dbPath, ownsScratch, cleanup } = await makeScratch("menu-scroll-");
  const app = await launch({ dbPath, userDataDir });
  const { attempt, must, summarize } = createRunner();
  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    // The composer's Labels chip can sit under the Monaco description field at
    // the default 1280x720 — give the dialog the room the app's own minimum
    // flow (940px wide) plus the height a full composer needs.
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window) window.setSize(1680, 1050);
    });
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    // Seed one real git-repo project, then reload → import into SQLite.
    const repo = await makeGitRepo(scratch, "fixture-");
    await seedProjects(page, [
      { id: "menu-scroll", name: "Scroll Probe", path: repo, prefix: "SP", colorIndex: 0 },
    ]);
    await goToBoard(page);

    // One ticket carrying LABEL_COUNT labels — the picker's vocabulary comes
    // from the project's labels plus what tickets use.
    const seeded = await page.evaluate(async (labelCount) => {
      const boot = await window.api.data.bootstrap();
      if (!boot.ok) return { ok: false, error: `bootstrap: ${boot.error}` };
      const project = boot.data.projects[0];
      if (!project) return { ok: false, error: "no project after import" };
      const res = await window.api.tickets.create({
        projectId: project.id,
        status: "todo",
        title: "Scroll smoke ticket",
        priority: "medium",
      });
      if (!res.ok) return { ok: false, error: `create: ${res.error}` };
      const labels = Array.from(
        { length: labelCount },
        (_, i) => `label-${String(i + 1).padStart(2, "0")}`,
      );
      const set = await window.api.tickets.setLabels({ ticketId: res.ticket.id, labels });
      if (!set.ok) return { ok: false, error: `setLabels: ${set.error}` };
      return { ok: true };
    }, LABEL_COUNT);
    if (!seeded.ok) throw new Error(seeded.error);

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1500);
    await goToBoard(page);

    // === 1+2. The composer's label picker, over the modal dialog ============
    await page.getByRole("button", { name: "New ticket", exact: true }).click();
    await sleep(400);
    await page.getByRole("button", { name: "Labels", exact: true }).click();
    await sleep(400);

    let geometry = await readList(page);
    await must(
      1,
      "wheel scrolls the composer's label picker (the VC-138 repro: popover list over a modal dialog)",
      async () => {
        if (geometry === null)
          return { ok: false, detail: "no [data-slot=command-list] on screen" };
        const overflows = geometry.scrollHeight > geometry.clientHeight;
        if (!overflows)
          return {
            ok: false,
            detail: `list does not overflow (${geometry.scrollHeight}x${geometry.clientHeight})`,
          };
        await wheelOverList(page, geometry, 320);
        const after = (await readList(page))?.scrollTop ?? 0;
        return {
          ok: after > 0,
          detail: `scrollTop ${geometry.scrollTop} -> ${after}`,
        };
      },
    );

    await attempt(2, "wheel-up scrolls the same list back down toward the top", async () => {
      const before = (await readList(page))?.scrollTop ?? 0;
      await wheelOverList(page, geometry, -320);
      const after = (await readList(page))?.scrollTop ?? 0;
      return { ok: after < before, detail: `scrollTop ${before} -> ${after}` };
    });

    await page.keyboard.press("Escape");
    await sleep(200);
    await page.keyboard.press("Escape");
    // Wait for the composer to be GONE, rather than sleeping 300ms and hoping.
    // The next line double-clicks a card on the board underneath, and a modal
    // that is still closing intercepts that pointer: on CI Playwright reported
    // the dialog's own Monaco `view-lines` div swallowing the dblclick while
    // the card sat there visible, enabled and stable. The section header below
    // says "NO dialog underneath" — this makes that true instead of likely.
    await page
      .locator('[data-testid="new-ticket-composer"]')
      .waitFor({ state: "detached", timeout: 10_000 })
      .catch(() => {});

    // === 3. The rail's label picker, with NO dialog underneath =============
    await page.locator("article").first().dblclick();
    await sleep(1200);
    await page.getByRole("button", { name: "Add label", exact: true }).first().click();
    await sleep(400);

    geometry = await readList(page);
    await attempt(
      3,
      "wheel still scrolls the ticket rail's label picker (no dialog open)",
      async () => {
        if (geometry === null)
          return { ok: false, detail: "no [data-slot=command-list] on screen" };
        await wheelOverList(page, geometry, 320);
        const after = (await readList(page))?.scrollTop ?? 0;
        return { ok: after > 0, detail: `scrollTop ${geometry.scrollTop} -> ${after}` };
      },
    );

    await page.keyboard.press("Escape");
    await sleep(300);
    await goToBoard(page);

    // === 4. The context menu's Labels submenu (own scroll lock) ============
    await page.locator("article").first().click({ button: "right" });
    await sleep(400);
    await page.getByRole("menuitem", { name: /Labels/ }).hover();
    await sleep(500);
    const sub = page.locator('[data-slot="context-menu-sub-content"]').first();
    const subGeometry = await sub.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      };
    });
    await attempt(4, "wheel still scrolls the context menu's Labels submenu", async () => {
      await page.mouse.move(
        subGeometry.x + subGeometry.width / 2,
        subGeometry.y + Math.min(subGeometry.height / 2, 80),
      );
      await page.mouse.wheel(0, 320);
      await sleep(300);
      const after = await sub.evaluate((el) => el.scrollTop);
      return { ok: after > 0, detail: `scrollTop ${subGeometry.scrollTop} -> ${after}` };
    });

    return summarize();
  } finally {
    await app.close().catch(() => {});
    if (ownsScratch) await cleanup();
  }
}

/** The numbered runner, imported at the top with the rest of the kit. */

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
